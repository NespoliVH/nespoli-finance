import Foundation
import Observation

/// Lista de transações do mês, com filtro (RF22) e correção de categoria (RF16 a RF18).
@MainActor
@Observable
final class TransactionsViewModel {
    private(set) var items: [Transaction] = []
    private(set) var isLoading = false
    private(set) var errorMessage: String?
    /// Aviso curto depois de uma correção, como "3 compras antigas também mudaram".
    private(set) var notice: String?
    private var nextCursor: String?

    let month: String
    var kind: TransactionKind = .all
    var category: CategoryID?
    private let repository: FinanceRepository

    init(repository: FinanceRepository, month: String, category: CategoryID? = nil) {
        self.repository = repository
        self.month = month
        self.category = category
        if category != nil { kind = .spending }
    }

    var canLoadMore: Bool { nextCursor != nil }

    func reload() async {
        nextCursor = nil
        await fetch(replacing: true)
    }

    func loadMore() async {
        guard nextCursor != nil, !isLoading else { return }
        await fetch(replacing: false)
    }

    private func fetch(replacing: Bool) async {
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await repository.transactions(month: month, kind: kind, category: category, cursor: replacing ? nil : nextCursor)
            items = replacing ? page.items : items + page.items
            nextCursor = page.nextCursor
            errorMessage = nil
        } catch let error as APIError {
            errorMessage = error.message
        } catch {
            errorMessage = APIError.invalidResponse.message
        }
    }

    /// Corrige e recarrega: com a regra, outras linhas da lista também mudam.
    func correct(_ tx: Transaction, to category: CategoryID, applyToFuture: Bool, includePast: Bool) async {
        do {
            let result = try await repository.correctCategory(
                transactionID: tx.id,
                CategoryCorrection(categoryId: category, applyToFuture: applyToFuture, includePast: applyToFuture && includePast)
            )
            notice = Self.notice(for: result)
            await reload()
        } catch let error as APIError {
            errorMessage = error.message
        } catch {
            errorMessage = APIError.invalidResponse.message
        }
    }

    func dismissNotice() { notice = nil }

    static func notice(for r: CategoryCorrectionResult) -> String {
        let name = r.transaction.categoryId?.name ?? "a nova categoria"
        guard r.ruleCreated else { return "Categoria trocada para \(name)." }
        switch r.recategorizedCount {
        case 0: return "As próximas compras deste lugar vão para \(name)."
        case 1: return "1 compra antiga deste lugar também foi para \(name), e as próximas vão junto."
        default: return "\(r.recategorizedCount) compras antigas deste lugar também foram para \(name), e as próximas vão junto."
        }
    }

    /// "2026-11-05" → "05/11".
    static func shortDate(_ date: String) -> String {
        let p = date.split(separator: "-")
        guard p.count == 3 else { return date }
        return "\(p[2])/\(p[1])"
    }
}
