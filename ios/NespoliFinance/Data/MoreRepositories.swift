import Foundation

/// Alertas de gasto (RF23, RF24).
protocol AlertsRepository {
    func alerts() async throws -> [SpendingAlert]
    func markRead(alertID: String) async throws
    func markAllRead() async throws
}

/// Estimativa de IR (RF25 a RF27).
protocol TaxRepository {
    /// nil quando o usuário ainda não preencheu o perfil.
    func taxProfile() async throws -> TaxProfile?
    func saveTaxProfile(_ profile: TaxProfile) async throws
    func taxEstimate() async throws -> TaxEstimateResponse
}

/// Conta e privacidade (RF04, RF05).
protocol AccountRepository {
    func me() async throws -> Me
    func consents() async throws -> [ConsentRecord]
    func deleteAccount() async throws
}

/// Tudo que o app usa, numa fonte só.
typealias AppRepository = FinanceRepository & AlertsRepository & TaxRepository & AccountRepository & ConnectionsRepository

private struct Empty: Encodable {}
private struct DeleteConfirmation: Encodable { let confirm = "EXCLUIR" }

extension LiveFinanceRepository: AlertsRepository, TaxRepository, AccountRepository {
    func alerts() async throws -> [SpendingAlert] {
        let list: AlertList = try await api.get("alerts")
        return list.items
    }

    func markRead(alertID: String) async throws {
        try await api.sendNoContent("POST", "alerts/\(alertID)/read", body: Optional<Empty>.none)
    }

    func markAllRead() async throws {
        try await api.sendNoContent("POST", "alerts/read-all", body: Optional<Empty>.none)
    }

    func taxProfile() async throws -> TaxProfile? {
        do {
            return try await api.get("tax/profile") as TaxProfile
        } catch APIError.notFound {
            return nil
        }
    }

    func saveTaxProfile(_ profile: TaxProfile) async throws {
        try await api.sendNoContent("PUT", "tax/profile", body: profile)
    }

    func taxEstimate() async throws -> TaxEstimateResponse {
        try await api.get("tax/estimate")
    }

    func me() async throws -> Me { try await api.get("me") }

    func consents() async throws -> [ConsentRecord] {
        let list: ConsentList = try await api.get("consents")
        return list.items
    }

    func deleteAccount() async throws {
        try await api.sendNoContent("DELETE", "me", body: DeleteConfirmation())
        api.clearCache()
    }
}
