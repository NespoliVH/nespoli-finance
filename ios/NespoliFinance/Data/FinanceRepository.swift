import Foundation

/// O que as telas precisam dos dados. As telas (via ViewModel) só conhecem
/// este protocolo; quem responde pode ser o backend de verdade ou o modo
/// demonstração. Isso também deixa os ViewModels testáveis sem rede.
protocol FinanceRepository {
    func summary(month: String?) async throws -> MonthSummary
    func transactions(month: String?, kind: TransactionKind, category: CategoryID?, cursor: String?) async throws -> TransactionPage
    func correctCategory(transactionID: String, _ correction: CategoryCorrection) async throws -> CategoryCorrectionResult
}

/// Backend real (rotas do módulo 6).
struct LiveFinanceRepository: FinanceRepository {
    let api: APIClient

    func summary(month: String?) async throws -> MonthSummary {
        try await api.get("summary", query: ["month": month])
    }

    func transactions(month: String?, kind: TransactionKind, category: CategoryID?, cursor: String?) async throws -> TransactionPage {
        try await api.get("transactions", query: [
            "month": month,
            "kind": kind.rawValue,
            "categoryId": category?.rawValue,
            "cursor": cursor,
        ])
    }

    func correctCategory(transactionID: String, _ correction: CategoryCorrection) async throws -> CategoryCorrectionResult {
        try await api.send("PATCH", "transactions/\(transactionID)/category", body: correction)
    }
}
