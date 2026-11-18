import Foundation

/// O que o Pluggy Connect avisa ao app enquanto o usuário conecta o banco.
enum PluggyConnectEvent: Equatable {
    case open
    case close
    /// Banco conectado. O id do item vai para o backend, que confere se ele
    /// foi criado com o token deste usuário antes de gravar.
    case success(itemID: String)
    case error(message: String, itemID: String?)
    /// Passos intermediários (banco escolhido, login enviado...), só informativos.
    case step(String)
}

/// Monta o endereço do Pluggy Connect e entende as mensagens que ele manda.
///
/// O Pluggy não tem SDK oficial em Swift. Os SDKs oficiais para celular
/// (React Native e Flutter) abrem a mesma página web numa WebView e escutam
/// as mensagens dela; aqui o protocolo é o mesmo, reproduzido em Swift.
enum PluggyConnect {
    static let baseURL = URL(string: "https://connect.pluggy.ai")!

    static func url(token: ConnectToken, includeSandbox: Bool) -> URL {
        var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        var items = [
            URLQueryItem(name: "connect_token", value: token.accessToken),
            URLQueryItem(name: "with_sandbox", value: includeSandbox ? "true" : "false"),
            URLQueryItem(name: "lang", value: "pt"),
            URLQueryItem(name: "countries", value: "BR"),
        ]
        // Reconectar abre direto no banco da conexão, no modo "atualizar".
        if let item = token.updateItem { items.append(URLQueryItem(name: "update_item", value: item)) }
        c.queryItems = items
        return c.url!
    }

    /// Mensagem da página: um JSON com `type` e `message`.
    struct BridgeMessage: Equatable {
        let type: String
        let message: String

        static func decode(_ body: Any) -> BridgeMessage? {
            guard let text = body as? String, let data = text.data(using: .utf8),
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let type = json["type"] as? String else { return nil }
            return BridgeMessage(type: type, message: json["message"] as? String ?? "")
        }
    }

    /// A página manda o estado como parâmetros de endereço numa mensagem
    /// LOCATION (`?events=OPEN,SUCCESS&item_id=...&timestamp=...`). O último
    /// evento da lista é o novo; a mesma marca de tempo repetida é ignorada.
    struct LocationParser {
        private(set) var lastTimestamp: String?

        mutating func parse(_ query: String) -> PluggyConnectEvent? {
            let trimmed = query.hasPrefix("?") ? String(query.dropFirst()) : query
            var c = URLComponents()
            c.percentEncodedQuery = trimmed
            var params: [String: String] = [:]
            for item in c.queryItems ?? [] { params[item.name] = item.value ?? "" }

            guard let event = params["events"]?.split(separator: ",").last.map(String.init), !event.isEmpty else { return nil }
            let timestamp = params["timestamp"]
            if let timestamp, timestamp == lastTimestamp { return nil }
            lastTimestamp = timestamp

            let itemID = params["item_id"].flatMap { $0.isEmpty ? nil : $0 }
            switch event {
            case "OPEN": return .open
            case "CLOSE": return .close
            case "SUCCESS":
                guard let itemID else { return .error(message: "O banco foi conectado, mas sem identificação.", itemID: nil) }
                return .success(itemID: itemID)
            case "ERROR": return .error(message: params["error"] ?? "", itemID: itemID)
            default: return .step(event)
            }
        }
    }
}
