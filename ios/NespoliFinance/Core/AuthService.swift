import Foundation

/// Resultado de uma tentativa de renovar a sessão.
enum RefreshOutcome: Equatable {
    /// Novo par de tokens salvo: pode repetir a chamada.
    case refreshed
    /// O backend recusou o token de renovação (vencido ou revogado): é preciso entrar de novo.
    case rejected
    /// Não deu para falar com o backend agora. A sessão continua guardada.
    case unavailable
}

struct AuthUser: Decodable, Equatable {
    let id: String
    let name: String?
    let email: String?
}

struct SignInResult: Decodable, Equatable {
    let accessToken: String
    let refreshToken: String
    let expiresIn: Int
    let isNewUser: Bool
    let user: AuthUser

    var tokens: SessionTokens { SessionTokens(accessToken: accessToken, refreshToken: refreshToken, expiresIn: expiresIn) }
}

/// O que o app manda ao backend depois que a Apple confirma o login.
struct AppleSignInRequest: Encodable, Equatable {
    struct FullName: Encodable, Equatable {
        let givenName: String?
        let familyName: String?
    }

    let identityToken: String
    let rawNonce: String
    /// A Apple só entrega o nome no primeiro login, e só para o app.
    let fullName: FullName?
}

/// Conversa com as rotas /auth do backend: entrar, renovar e sair.
///
/// É um actor para que duas telas que recebem 401 ao mesmo tempo não
/// disparem duas renovações. Como o token de renovação é trocado a cada uso,
/// a segunda renovação usaria um token já gasto e derrubaria a sessão.
actor AuthService {
    private let store: SessionStore
    /// Cliente sem token, para entrar e renovar.
    private let publicAPI: APIClient
    /// Cliente com o token de acesso, para sair.
    private let authedAPI: APIClient
    private var refreshing: Task<RefreshOutcome, Never>?

    init(baseURL: URL, session: URLSession = .shared, store: SessionStore) {
        self.store = store
        let noCache = ResponseCache(directory: nil)
        publicAPI = APIClient(baseURL: baseURL, session: session, cache: noCache, tokenProvider: { nil })
        authedAPI = APIClient(baseURL: baseURL, session: session, cache: noCache, tokenProvider: { store.accessToken })
    }

    /// Troca o token da Apple por uma sessão do app e guarda no Keychain.
    func signIn(_ request: AppleSignInRequest) async throws -> SignInResult {
        let result: SignInResult = try await publicAPI.send("POST", "auth/apple", body: request)
        try store.save(result.tokens)
        return result
    }

    /// Renova o par de tokens. Chamadas simultâneas esperam a mesma renovação.
    func refresh() async -> RefreshOutcome {
        if let refreshing { return await refreshing.value }
        let task = Task { await performRefresh() }
        refreshing = task
        let outcome = await task.value
        refreshing = nil
        return outcome
    }

    /// Avisa o backend (que revoga a sessão) e apaga os tokens do aparelho.
    /// Mesmo sem rede, os tokens locais são apagados: sair nunca falha para o usuário.
    func signOut() async {
        if store.hasSession {
            try? await authedAPI.sendNoContent("POST", "auth/logout", body: Optional<[String: String]>.none)
        }
        store.clear()
    }

    private func performRefresh() async -> RefreshOutcome {
        guard let refreshToken = store.refreshToken else { return .rejected }
        do {
            let tokens: SessionTokens = try await publicAPI.send("POST", "auth/refresh", body: ["refreshToken": refreshToken])
            try store.save(tokens)
            return .refreshed
        } catch APIError.unauthorized {
            store.clear()
            return .rejected
        } catch {
            return .unavailable
        }
    }
}
