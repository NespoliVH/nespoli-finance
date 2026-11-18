import XCTest
@testable import NespoliFinance

@MainActor
final class ViewModelTests: XCTestCase {
    func testMonthNavigation() {
        XCTAssertEqual(SummaryViewModel.shift("2026-01", by: -1), "2025-12")
        XCTAssertEqual(SummaryViewModel.shift("2026-12", by: 1), "2027-01")
        XCTAssertEqual(SummaryViewModel.title("2026-11"), "novembro de 2026")
        XCTAssertEqual(SummaryViewModel.title("2026-03"), "março de 2026")
    }

    func testSummaryLoadsAndHidesEmptySlices() async {
        let model = SummaryViewModel(repository: DemoFinanceRepository(month: "2026-11"), month: "2026-11")
        await model.load()
        guard case .loaded(let s) = model.state else { return XCTFail("não carregou") }
        XCTAssertEqual(s.month, "2026-11")
        XCTAssertTrue(model.chartSlices.allSatisfy { $0.totalCents > 0 })
    }

    func testSummaryShowsFriendlyErrorWhenOffline() async {
        let model = SummaryViewModel(repository: FailingRepository(error: .offline), month: "2026-11")
        await model.load()
        XCTAssertEqual(model.state, .failed(APIError.offline.message))
    }

    func testCorrectionNoticeTellsHowManyOldPurchasesChanged() async {
        let model = TransactionsViewModel(repository: DemoFinanceRepository(month: "2026-11"), month: "2026-11")
        await model.reload()
        let ifood = model.items.first { $0.id == "d07" }!
        await model.correct(ifood, to: .comida, applyToFuture: true, includePast: true)
        XCTAssertEqual(model.notice, "2 compras antigas deste lugar também foram para Comida, e as próximas vão junto.")
        XCTAssertEqual(model.items.filter { $0.description.hasPrefix("IFOOD") }.map(\.categoryId), [.comida, .comida, .comida])
    }

    func testShortDate() {
        XCTAssertEqual(TransactionsViewModel.shortDate("2026-11-05"), "05/11")
    }
}

struct FailingRepository: AppRepository {
    let error: APIError
    func summary(month: String?) async throws -> MonthSummary { throw error }
    func transactions(month: String?, kind: TransactionKind, category: CategoryID?, cursor: String?) async throws -> TransactionPage { throw error }
    func correctCategory(transactionID: String, _ correction: CategoryCorrection) async throws -> CategoryCorrectionResult { throw error }
    func alerts() async throws -> [SpendingAlert] { throw error }
    func markRead(alertID: String) async throws { throw error }
    func markAllRead() async throws { throw error }
    func taxProfile() async throws -> TaxProfile? { throw error }
    func saveTaxProfile(_ profile: TaxProfile) async throws { throw error }
    func taxEstimate() async throws -> TaxEstimateResponse { throw error }
    func me() async throws -> Me { throw error }
    func consents() async throws -> [ConsentRecord] { throw error }
    func deleteAccount() async throws { throw error }
    var usesPluggyWidget: Bool { true }
    func connections() async throws -> [BankConnection] { throw error }
    func connectToken(connectionID: String?) async throws -> ConnectToken { throw error }
    func createConnection(itemID: String, termsVersion: String, appVersion: String) async throws { throw error }
    func reconnected(connectionID: String, termsVersion: String, appVersion: String) async throws { throw error }
    func syncConnection(connectionID: String) async throws { throw error }
    func deleteConnection(connectionID: String) async throws { throw error }
}
