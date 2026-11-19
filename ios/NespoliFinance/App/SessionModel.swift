import Foundation
import Observation

/// Estado da sessão do app (módulo 3): quem está usando e de onde vêm os dados.
///
/// Três estados possíveis:
/// - signedOut: tela de entrada, com "Iniciar sessão com a Apple" e o modo demonstração;
/// - demo: dados de exemplo, sem backend nem conta;
/// - signedIn: sessão real, com os tokens guardados no Keychain.
@MainActor
@Observable
final class SessionModel {
    enum State: Equatable { case signedOut, demo, signedIn }

    private(set) var state: State = .signedOut
    private(set) var environment: AppEnvironment?
    /// Muda a cada troca de ambiente, para as telas recriarem seus ViewModels.
    private(set) var generation = 0
    private(set) var isSigningIn = false
    private(set) var errorMessage: String?
    /// Aviso na tela de entrada, como "sessão terminou" ou "conta excluída".
    private(set) var notice: String?

    /// Lembra entre aberturas que a pessoa escolheu o modo demonstração.
    nonisolated static let demoModeKey = "demoMode"

    private let baseURL: URL?
    private let urlSession: URLSession
    private let store: SessionStore
    private let auth: AuthService?
    private let defaults: UserDefaults
    /// Nonce sorteado para o pedido em andamento à Apple. Usado uma vez só.
    private var pendingNonce: String?

    init(baseURL: URL? = AppEnvironment.apiBaseURL, store: SessionStore = SessionStore(),
         defaults: UserDefaults = .standard, urlSession: URLSession = .shared) {
        self.baseURL = baseURL
        self.store = store
        self.defaults = defaults
        self.urlSession = urlSession
        auth = baseURL.map { AuthService(baseURL: $0, session: urlSession, store: store) }

        if baseURL != nil, store.hasSession {
            enterLive()
        } else if defaults.bool(forKey: Self.demoModeKey) {
            enterDemo()
        }
    }

    func startDemo() {
        defaults.set(true, forKey: Self.demoModeKey)
        notice = nil
        errorMessage = nil
        enterDemo()
    }

    /// Prepara o pedido à Apple: sorteia o nonce e devolve o hash que vai no pedido.
    func prepareAppleRequest() -> String {
        let raw = Nonce.random()
        pendingNonce = raw
        errorMessage = nil
        return Nonce.sha256(raw)
    }

    /// A Apple confirmou: troca o token dela por uma sessão no backend.
    func completeApple(identityToken: Data?, givenName: String?, familyName: String?) async {
        guard let rawNonce = pendingNonce,
              let tokenData = identityToken, let token = String(data: tokenData, encoding: .utf8) else {
            errorMessage = "Não recebemos a confirmação da Apple. Tente de novo."
            return
        }
        pendingNonce = nil
        guard let auth else {
            errorMessage = "O servidor do app ainda não está no ar. Use o modo demonstração por enquanto."
            return
        }
        let name = (givenName == nil && familyName == nil)
            ? nil : AppleSignInRequest.FullName(givenName: givenName, familyName: familyName)

        isSigningIn = true
        defer { isSigningIn = false }
        do {
            _ = try await auth.signIn(AppleSignInRequest(identityToken: token, rawNonce: rawNonce, fullName: name))
            defaults.set(false, forKey: Self.demoModeKey)
            notice = nil
            errorMessage = nil
            enterLive()
        } catch {
            errorMessage = Self.signInMessage(for: error)
        }
    }

    /// Erro devolvido pela tela da Apple. Cancelar não é erro: só fecha.
    func appleFailed(canceled: Bool) {
        pendingNonce = nil
        errorMessage = canceled ? nil : "Não foi possível entrar com a Apple. Tente de novo."
    }

    /// Sair pelos Ajustes. No modo real, revoga a sessão no backend e apaga a cópia offline.
    func signOut() async {
        if state == .signedIn { await auth?.signOut() }
        leave(notice: nil)
    }

    /// Depois de excluir a conta, a sessão já não existe no backend.
    func accountDeleted() {
        leave(notice: "Conta excluída. Seus dados foram apagados do app e do serviço do banco.")
    }

    /// A renovação foi recusada (token vencido ou revogado em outro lugar).
    func sessionExpired() {
        guard state == .signedIn else { return }
        leave(notice: APIError.unauthorized.message)
    }

    nonisolated static func signInMessage(for error: Error) -> String {
        switch error as? APIError {
        case .offline?: return "Sem conexão com a internet. Conecte-se para entrar."
        case .unauthorized?: return "Não conseguimos confirmar seu login com a Apple. Tente de novo."
        case .server(_, let code?)? where code == "apple_unavailable": return "A Apple não respondeu agora. Tente de novo em alguns minutos."
        default: return "Algo deu errado ao entrar. Tente de novo."
        }
    }

    // MARK: Trocas de estado

    private func enterDemo() {
        environment = .demo()
        state = .demo
        generation += 1
    }

    private func enterLive() {
        guard let baseURL, let auth else { return }
        let store = self.store
        let api = APIClient(baseURL: baseURL, session: urlSession, tokenProvider: { store.accessToken }) { [weak self] in
            let outcome = await auth.refresh()
            if outcome == .rejected { await self?.sessionExpired() }
            return outcome
        }
        environment = .live(api: api)
        state = .signedIn
        generation += 1
    }

    private func leave(notice: String?) {
        environment?.api?.clearCache()
        store.clear()
        defaults.set(false, forKey: Self.demoModeKey)
        environment = nil
        state = .signedOut
        generation += 1
        errorMessage = nil
        self.notice = notice
    }
}
