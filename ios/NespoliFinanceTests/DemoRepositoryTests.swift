import XCTest
@testable import NespoliFinance

/// O modo demonstração segue as mesmas regras do backend.
final class DemoRepositoryTests: XCTestCase {
    let month = "2026-11"

    func testSummaryCountsOnlySpending() async throws {
        let repo = DemoFinanceRepository(month: month)
        let s = try await repo.summary(month: month)
        // Salário, PIX recebido e pagamento da fatura ficam fora (RF19).
        let expected = [180_000, 21_450, 6_890, 34_210, 5_590, 4_250, 8_990, 45_000, 7_900].reduce(0, +)
        XCTAssertEqual(s.totalCents, expected)
        XCTAssertEqual(s.categories.map(\.id), CategoryID.allCases)
        // Cada percentual é arredondado sozinho, então a soma pode errar por um ou dois pontos-base.
        XCTAssertLessThanOrEqual(abs(s.categories.map(\.percentBasisPoints).reduce(0, +) - 10_000), 2)
    }

    func testRuleRecategorizesPastPurchasesButKeepsManualOnes() async throws {
        let repo = DemoFinanceRepository(month: month)
        // Uma compra do iFood já corrigida à mão, antes da regra.
        _ = try await repo.correctCategory(transactionID: "d11", CategoryCorrection(categoryId: .imprevistos, applyToFuture: false, includePast: false))

        let r = try await repo.correctCategory(transactionID: "d07", CategoryCorrection(categoryId: .comida, applyToFuture: true, includePast: true))
        XCTAssertTrue(r.ruleCreated)
        XCTAssertEqual(r.recategorizedCount, 1) // d04; d11 era manual

        let items = try await repo.transactions(month: month, kind: .all, category: nil, cursor: nil).items
        XCTAssertEqual(items.first { $0.id == "d04" }?.categorySource, "user_rule")
        XCTAssertEqual(items.first { $0.id == "d11" }?.categoryId, .imprevistos)
    }

    func testWithoutPastOnlyTheCorrectedOneChanges() async throws {
        let repo = DemoFinanceRepository(month: month)
        let r = try await repo.correctCategory(transactionID: "d07", CategoryCorrection(categoryId: .comida, applyToFuture: true, includePast: false))
        XCTAssertEqual(r.recategorizedCount, 0)
        let items = try await repo.transactions(month: month, kind: .all, category: nil, cursor: nil).items
        XCTAssertEqual(items.first { $0.id == "d11" }?.categoryId, .outros)
    }

    func testRefusesCorrectingIncome() async {
        let repo = DemoFinanceRepository(month: month)
        do {
            _ = try await repo.correctCategory(transactionID: "d01", CategoryCorrection(categoryId: .comida, applyToFuture: false, includePast: false))
            XCTFail("deveria recusar")
        } catch {
            XCTAssertEqual(error as? APIError, .server(status: 422, code: "not_spending"))
        }
    }

    func testFiltersByKindAndCategory() async throws {
        let repo = DemoFinanceRepository(month: month)
        let income = try await repo.transactions(month: month, kind: .income, category: nil, cursor: nil).items
        XCTAssertEqual(Set(income.map(\.id)), ["d01", "d12"])
        let food = try await repo.transactions(month: month, kind: .spending, category: .comida, cursor: nil).items
        XCTAssertEqual(Set(food.map(\.id)), ["d04", "d05"])
        let all = try await repo.transactions(month: month, kind: .all, category: nil, cursor: nil).items
        XCTAssertEqual(all.first?.id, "d12") // mais recente primeiro
    }
}
