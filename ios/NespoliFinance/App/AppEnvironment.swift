import Foundation

/// Decide de onde vêm os dados ao abrir o app.
///
/// Sem endereço do backend ou sem sessão salva no Keychain, o app abre no
/// modo demonstração. O login com a Apple (módulo 3) é o que vai gravar a
/// sessão e ligar o modo real.
struct AppEnvironment {
    let repository: AppRepository
    let isDemo: Bool

    /// Endereço do backend em produção. Fica vazio até a hospedagem existir.
    static let apiBaseURL: URL? = nil
    static let accessTokenKey = "access_token"
    /// Mostra os bancos de teste do Pluggy (sandbox) no Pluggy Connect. Fica
    /// ligado no protótipo do TCC; desligar antes de publicar na App Store.
    static let pluggyIncludeSandbox = true

    static func make(keychain: KeychainStore = KeychainStore()) -> AppEnvironment {
        if let base = apiBaseURL, keychain.get(accessTokenKey) != nil {
            let api = APIClient(baseURL: base) { keychain.get(accessTokenKey) }
            return AppEnvironment(repository: LiveFinanceRepository(api: api), isDemo: false)
        }
        return AppEnvironment(repository: DemoFinanceRepository(), isDemo: true)
    }
}
