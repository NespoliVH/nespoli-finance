import Foundation

/// Erros que a tela sabe explicar (RNF16): cada um vira uma mensagem clara
/// com a opção de tentar de novo, sem fechar o app.
enum APIError: Error, Equatable {
    case offline
    case unauthorized
    case notFound
    case server(status: Int, code: String?)
    case invalidResponse

    var message: String {
        switch self {
        case .offline: return "Sem conexão com a internet. Mostrando os últimos dados salvos."
        case .unauthorized: return "Sua sessão terminou. Entre de novo para continuar."
        case .notFound: return "Não encontramos esse item. Ele pode ter sido apagado."
        case .server(_, let code) where code == "pluggy_unavailable":
            return "O serviço do banco não respondeu. Tente de novo em alguns minutos."
        case .server: return "Algo deu errado do nosso lado. Tente de novo."
        case .invalidResponse: return "Recebemos uma resposta inesperada. Tente de novo."
        }
    }
}

/// Cliente HTTP do backend, com async/await sobre URLSession.
///
/// Toda chamada leva o token de acesso do Keychain. As leituras usam ETag:
/// o cliente guarda a última resposta de cada endereço e manda a etiqueta
/// dela. Se o backend responder 304 (nada mudou), usa a cópia guardada.
///
/// O token de acesso dura 15 minutos. Quando o backend responde 401, o
/// cliente pede uma renovação (refresher) e repete a chamada uma única vez,
/// sem o usuário perceber. Se a renovação for recusada, o erro sobe como
/// .unauthorized e o app volta para a tela de login.
final class APIClient {
    let baseURL: URL
    private let session: URLSession
    private let tokenProvider: () -> String?
    private let refresher: (() async -> RefreshOutcome)?
    private let cache: ResponseCache

    init(baseURL: URL, session: URLSession = .shared, cache: ResponseCache = ResponseCache(),
         tokenProvider: @escaping () -> String?, refresher: (() async -> RefreshOutcome)? = nil) {
        self.baseURL = baseURL
        self.session = session
        self.cache = cache
        self.tokenProvider = tokenProvider
        self.refresher = refresher
    }

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        // O backend manda datas como "2026-11-18T10:00:00.000Z". O .iso8601
        // padrão não aceita os milissegundos, então o formato é montado aqui.
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        d.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = withFraction.date(from: text) ?? plain.date(from: text) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Data inválida: \(text)"))
        }
        return d
    }()

    func get<T: Decodable>(_ path: String, query: [String: String?] = [:]) async throws -> T {
        let url = makeURL(path, query: query)
        var request = URLRequest(url: url)
        let cached = cache.entry(for: url)
        if let etag = cached?.etag { request.setValue(etag, forHTTPHeaderField: "If-None-Match") }

        do {
            let (data, http) = try await send(request)
            if http.statusCode == 304, let cached {
                return try Self.decoder.decode(T.self, from: cached.body)
            }
            try check(http, data)
            if let etag = http.value(forHTTPHeaderField: "ETag") {
                cache.store(url: url, etag: etag, body: data)
            }
            return try Self.decoder.decode(T.self, from: data)
        } catch APIError.offline {
            // Sem rede: a última cópia, se houver (RNF15).
            if let cached { return try Self.decoder.decode(T.self, from: cached.body) }
            throw APIError.offline
        }
    }

    func send<Body: Encodable, T: Decodable>(_ method: String, _ path: String, body: Body) async throws -> T {
        var request = URLRequest(url: makeURL(path, query: [:]))
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, http) = try await send(request)
        try check(http, data)
        return try Self.decoder.decode(T.self, from: data)
    }

    /// Pedido sem resposta útil no corpo (204), como marcar alerta como lido ou excluir a conta.
    func sendNoContent<Body: Encodable>(_ method: String, _ path: String, body: Body?) async throws {
        var request = URLRequest(url: makeURL(path, query: [:]))
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        let (data, http) = try await send(request)
        try check(http, data)
    }

    /// Ao sair ou excluir a conta, a cópia offline também vai embora.
    func clearCache() { cache.clear() }

    private func makeURL(_ path: String, query: [String: String?]) -> URL {
        var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        let items = query.compactMap { key, value in value.map { URLQueryItem(name: key, value: $0) } }
        if !items.isEmpty { components.queryItems = items.sorted { $0.name < $1.name } }
        return components.url!
    }

    private func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, http) = try await perform(request)
        guard http.statusCode == 401, let refresher else { return (data, http) }
        switch await refresher() {
        case .refreshed:
            // Repete uma vez só, já com o token novo. Um segundo 401 vira erro.
            return try await perform(request)
        case .rejected:
            return (data, http)
        case .unavailable:
            throw APIError.offline
        }
    }

    private func perform(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        var request = request
        if let token = tokenProvider() { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        request.timeoutInterval = 30
        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { throw APIError.invalidResponse }
            return (data, http)
        } catch let error as URLError where [.notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotConnectToHost, .cannotFindHost].contains(error.code) {
            throw APIError.offline
        }
    }

    private func check(_ http: HTTPURLResponse, _ data: Data) throws {
        switch http.statusCode {
        case 200..<300: return
        case 401: throw APIError.unauthorized
        case 404: throw APIError.notFound
        default:
            let code = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw APIError.server(status: http.statusCode, code: code)
        }
    }
}

/// Últimas respostas por endereço, com a etiqueta (ETag) de cada uma.
///
/// Fica em arquivo dentro do app, protegido pela criptografia de arquivos do
/// iOS (só abre com o aparelho desbloqueado). A arquitetura previa SwiftData
/// para isso; para guardar "a última resposta de cada tela", um arquivo por
/// endereço é mais simples e faz o mesmo.
final class ResponseCache {
    struct Entry: Codable { let etag: String; let body: Data }

    private let directory: URL?
    private var memory: [URL: Entry] = [:]
    private let lock = NSLock()

    /// directory nil = só em memória (testes).
    init(directory: URL? = ResponseCache.defaultDirectory) {
        self.directory = directory
        if let directory { try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
    }

    static var defaultDirectory: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("respostas", isDirectory: true)
    }

    func entry(for url: URL) -> Entry? {
        lock.lock(); defer { lock.unlock() }
        if let e = memory[url] { return e }
        guard let file = fileURL(url), let data = try? Data(contentsOf: file),
              let e = try? JSONDecoder().decode(Entry.self, from: data) else { return nil }
        memory[url] = e
        return e
    }

    func store(url: URL, etag: String, body: Data) {
        lock.lock(); defer { lock.unlock() }
        let e = Entry(etag: etag, body: body)
        memory[url] = e
        if let file = fileURL(url), let data = try? JSONEncoder().encode(e) {
            try? data.write(to: file, options: [.atomic, .completeFileProtection])
        }
    }

    /// Ao sair ou excluir a conta, nada do usuário fica no aparelho.
    func clear() {
        lock.lock(); defer { lock.unlock() }
        memory = [:]
        if let directory { try? FileManager.default.removeItem(at: directory) }
        if let directory { try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
    }

    private func fileURL(_ url: URL) -> URL? {
        guard let directory else { return nil }
        // Nome do arquivo derivado do endereço, sem caracteres especiais.
        let name = Data(url.absoluteString.utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-")
        return directory.appendingPathComponent(String(name.prefix(200)))
    }
}
