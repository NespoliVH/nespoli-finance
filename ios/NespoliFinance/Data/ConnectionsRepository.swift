import Foundation

/// Conexões bancárias (RF06 a RF14).
protocol ConnectionsRepository {
    /// Falso no modo demonstração, que conecta um banco de exemplo sem abrir o Pluggy.
    var usesPluggyWidget: Bool { get }
    func connections() async throws -> [BankConnection]
    func connectToken(connectionID: String?) async throws -> ConnectToken
    /// Grava a conexão nova junto com o consentimento (termos aceitos).
    func createConnection(itemID: String, termsVersion: String, appVersion: String) async throws
    /// Avisa que o usuário reconectou: novo consentimento e nova sincronização.
    func reconnected(connectionID: String, termsVersion: String, appVersion: String) async throws
    func syncConnection(connectionID: String) async throws
    func deleteConnection(connectionID: String) async throws
}

private struct NewConnectionBody: Encodable { let itemId: String; let termsVersion: String; let appVersion: String }
private struct TermsBody: Encodable { let termsVersion: String; let appVersion: String }
private struct ConnectTokenBody: Encodable { let connectionId: String? }
private struct NoBody: Encodable {}

extension LiveFinanceRepository: ConnectionsRepository {
    var usesPluggyWidget: Bool { true }

    func connections() async throws -> [BankConnection] {
        try await api.get("connections")
    }

    func connectToken(connectionID: String?) async throws -> ConnectToken {
        try await api.send("POST", "connections/connect-token", body: ConnectTokenBody(connectionId: connectionID))
    }

    func createConnection(itemID: String, termsVersion: String, appVersion: String) async throws {
        try await api.sendNoContent("POST", "connections", body: NewConnectionBody(itemId: itemID, termsVersion: termsVersion, appVersion: appVersion))
    }

    func reconnected(connectionID: String, termsVersion: String, appVersion: String) async throws {
        try await api.sendNoContent("POST", "connections/\(connectionID)/reconnected", body: TermsBody(termsVersion: termsVersion, appVersion: appVersion))
    }

    func syncConnection(connectionID: String) async throws {
        try await api.sendNoContent("POST", "connections/\(connectionID)/sync", body: Optional<NoBody>.none)
    }

    func deleteConnection(connectionID: String) async throws {
        try await api.sendNoContent("DELETE", "connections/\(connectionID)", body: Optional<NoBody>.none)
    }
}
