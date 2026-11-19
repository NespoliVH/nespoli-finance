import Foundation

/// De onde vêm os dados das telas: do backend (sessão real) ou do modo demonstração.
///
/// Quem decide qual dos dois usar é o SessionModel, a partir do login.
struct AppEnvironment {
    let repository: AppRepository
    let isDemo: Bool
    /// Cliente do backend no modo real, para apagar a cópia offline ao sair.
    let api: APIClient?

    /// Endereço do backend em produção. Fica vazio até a hospedagem existir.
    static let apiBaseURL: URL? = nil
    /// Mostra os bancos de teste do Pluggy (sandbox) no Pluggy Connect. Fica
    /// ligado no protótipo do TCC; desligar antes de publicar na App Store.
    static let pluggyIncludeSandbox = true

    static func demo() -> AppEnvironment {
        AppEnvironment(repository: DemoFinanceRepository(), isDemo: true, api: nil)
    }

    static func live(api: APIClient) -> AppEnvironment {
        AppEnvironment(repository: LiveFinanceRepository(api: api), isDemo: false, api: api)
    }
}
