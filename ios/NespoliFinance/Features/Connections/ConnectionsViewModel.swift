import Foundation
import Observation

/// Bancos conectados (RF06 a RF14): listar, conectar, reconectar, atualizar e desconectar.
@MainActor
@Observable
final class ConnectionsViewModel {
    /// O fluxo de conectar um banco, mostrado numa folha (sheet) só.
    struct Flow: Identifiable, Equatable {
        enum Stage: Equatable {
            /// O usuário lê o que será compartilhado e aceita (LGPD).
            case consent
            case loading
            case pluggy(URL)
        }
        let id = UUID()
        /// nil para um banco novo; o id da conexão quando é para reconectar.
        let connectionID: String?
        let institutionName: String?
        var stage: Stage = .consent
    }

    private(set) var connections: [BankConnection] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    private(set) var notice: String?
    var flow: Flow?

    private let repository: ConnectionsRepository
    private let includeSandbox: Bool
    private let appVersion: String

    /// Versão dos termos de compartilhamento gravada no consentimento. Muda
    /// quando o texto mudar, para o registro dizer o que o usuário aceitou.
    nonisolated static let termsVersion = "1.0"
    /// Mesmo texto da finalidade que o backend grava (BANK_DATA_PURPOSE).
    nonisolated static let purpose = "Ler saldos e transações das contas escolhidas para categorizar gastos, gerar alertas e estimar o IR no app Nespoli Finance."

    init(repository: ConnectionsRepository, includeSandbox: Bool = AppEnvironment.pluggyIncludeSandbox,
         appVersion: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0") {
        self.repository = repository
        self.includeSandbox = includeSandbox
        self.appVersion = appVersion
    }

    var usesPluggyWidget: Bool { repository.usesPluggyWidget }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            connections = try await repository.connections()
            errorMessage = nil
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    func beginConnect() {
        notice = nil
        flow = Flow(connectionID: nil, institutionName: nil)
    }

    func beginReconnect(_ connection: BankConnection) {
        notice = nil
        flow = Flow(connectionID: connection.id, institutionName: connection.institutionName)
    }

    /// Depois do aceite: pede o token ao backend e abre o Pluggy Connect. No
    /// modo demonstração não há Pluggy, então a conexão é criada direto.
    func acceptConsent() async {
        guard var current = flow, current.stage == .consent else { return }
        current.stage = .loading
        flow = current
        if !repository.usesPluggyWidget {
            await finish(itemID: "demo-\(UUID().uuidString.prefix(8))", for: current)
            return
        }
        do {
            let token = try await repository.connectToken(connectionID: current.connectionID)
            guard flow?.id == current.id else { return } // o usuário fechou a folha nesse meio-tempo
            current.stage = .pluggy(PluggyConnect.url(token: token, includeSandbox: includeSandbox))
            flow = current
        } catch {
            flow = nil
            errorMessage = Self.message(for: error)
        }
    }

    func handle(_ event: PluggyConnectEvent) async {
        guard let current = flow else { return }
        switch event {
        case .success(let itemID):
            await finish(itemID: itemID, for: current)
        case .close:
            flow = nil
        case .error, .open, .step:
            // O Pluggy mostra o erro na própria página e deixa tentar de novo.
            break
        }
    }

    func sync(_ connection: BankConnection) async {
        do {
            try await repository.syncConnection(connectionID: connection.id)
            notice = "Atualização pedida. Os dados novos aparecem em alguns minutos."
            await load()
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    func disconnect(_ connection: BankConnection) async {
        do {
            try await repository.deleteConnection(connectionID: connection.id)
            connections.removeAll { $0.id == connection.id }
            notice = "\(connection.institutionName) foi desconectado. As transações dele foram apagadas do app."
        } catch {
            errorMessage = Self.message(for: error)
        }
    }

    private func finish(itemID: String, for current: Flow) async {
        do {
            if let id = current.connectionID {
                try await repository.reconnected(connectionID: id, termsVersion: Self.termsVersion, appVersion: appVersion)
                notice = "Banco reconectado. Estamos buscando os dados novos."
            } else {
                do {
                    try await repository.createConnection(itemID: itemID, termsVersion: Self.termsVersion, appVersion: appVersion)
                } catch APIError.server(409, "already_connected"?) {
                    // O mesmo banco já estava ligado à conta: nada a gravar de novo.
                }
                notice = "Banco conectado. As transações aparecem em alguns minutos."
            }
            errorMessage = nil
        } catch {
            errorMessage = Self.message(for: error)
        }
        flow = nil
        await load()
    }

    nonisolated static func message(for error: Error) -> String {
        guard let apiError = error as? APIError else { return APIError.invalidResponse.message }
        switch apiError {
        case .server(_, "item_not_owned"?):
            return "Essa conexão não pertence à sua conta. Tente conectar o banco de novo."
        case .server(_, "pluggy_not_configured"?):
            return "A conexão com bancos ainda não está disponível no servidor."
        default:
            return apiError.message
        }
    }

    nonisolated static func lastSyncText(_ date: Date?, now: Date = Date()) -> String {
        guard let date else { return "Ainda não sincronizado" }
        let f = RelativeDateTimeFormatter()
        f.locale = Locale(identifier: "pt_BR")
        return "Atualizado \(f.localizedString(for: date, relativeTo: now))"
    }
}
