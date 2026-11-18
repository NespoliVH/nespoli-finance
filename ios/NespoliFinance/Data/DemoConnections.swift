import Foundation

/// Conexões bancárias no modo demonstração. Nada sai do aparelho: conectar
/// cria um banco de exemplo, e reconectar só muda o estado para "em dia".
extension DemoFinanceRepository: ConnectionsRepository {
    nonisolated var usesPluggyWidget: Bool { false }

    static func sampleConnections(now: Date = Date()) -> [BankConnection] {
        [
            BankConnection(
                id: "conn-1", institutionName: "Banco de demonstração", status: .active,
                consentExpiresAt: now.addingTimeInterval(300 * 86_400), lastSyncedAt: now.addingTimeInterval(-3_600),
                accounts: [
                    BankAccount(id: "acc-1", type: "checking", name: "Conta corrente", numberLast4: "4321", balanceCents: 348_219),
                    BankAccount(id: "acc-2", type: "credit_card", name: "Cartão de crédito", numberLast4: "9876", balanceCents: -112_040),
                ]
            ),
            BankConnection(
                id: "conn-2", institutionName: "Banco exemplo 2", status: .active,
                consentExpiresAt: now.addingTimeInterval(120 * 86_400), lastSyncedAt: now.addingTimeInterval(-2 * 3_600),
                accounts: [
                    BankAccount(id: "acc-3", type: "savings", name: "Poupança", numberLast4: "1122", balanceCents: 1_050_000),
                ]
            ),
        ]
    }

    func connections() async throws -> [BankConnection] { demoConnections }

    func connectToken(connectionID: String?) async throws -> ConnectToken {
        ConnectToken(accessToken: "demo", updateItem: connectionID)
    }

    func createConnection(itemID: String, termsVersion: String, appVersion: String) async throws {
        let n = demoConnections.count + 1
        demoConnections.append(BankConnection(
            id: "conn-\(itemID)", institutionName: "Banco de demonstração \(n)", status: .active,
            consentExpiresAt: Date().addingTimeInterval(365 * 86_400), lastSyncedAt: Date(),
            accounts: [BankAccount(id: "acc-\(itemID)", type: "checking", name: "Conta corrente", numberLast4: "0000", balanceCents: 0)]
        ))
    }

    func reconnected(connectionID: String, termsVersion: String, appVersion: String) async throws {
        guard let i = demoConnections.firstIndex(where: { $0.id == connectionID }) else { throw APIError.notFound }
        demoConnections[i].status = .active
        demoConnections[i].lastSyncedAt = Date()
    }

    func syncConnection(connectionID: String) async throws {
        guard let i = demoConnections.firstIndex(where: { $0.id == connectionID }) else { throw APIError.notFound }
        demoConnections[i].lastSyncedAt = Date()
    }

    func deleteConnection(connectionID: String) async throws {
        guard demoConnections.contains(where: { $0.id == connectionID }) else { throw APIError.notFound }
        demoConnections.removeAll { $0.id == connectionID }
    }
}
