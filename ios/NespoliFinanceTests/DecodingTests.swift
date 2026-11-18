import XCTest
@testable import NespoliFinance

/// Respostas copiadas do formato que o backend devolve (módulo 6).
final class DecodingTests: XCTestCase {
    func testDecodesSummaryWithMillisecondDates() throws {
        let json = """
        {"month":"2026-11","totalCents":98000,
         "categories":[{"id":"comida","name":"Comida","icon":"fork.knife","totalCents":98000,"count":3,"percentBasisPoints":10000},
                       {"id":"outros","name":"Outros","icon":"square.grid.2x2.fill","totalCents":0,"count":0,"percentBasisPoints":0}],
         "unreadAlerts":1,
         "connections":{"count":1,"importing":false,"oldestSyncAt":"2026-11-18T10:00:00.000Z"}}
        """
        let s = try APIClient.decoder.decode(MonthSummary.self, from: Data(json.utf8))
        XCTAssertEqual(s.totalCents, 98_000)
        XCTAssertEqual(s.categories.first?.id, .comida)
        XCTAssertEqual(s.connections.oldestSyncAt, ISO8601DateFormatter().date(from: "2026-11-18T10:00:00Z"))
    }

    func testDecodesTransactionPageAndIgnoresExtraFields() throws {
        let json = """
        {"items":[{"id":"7c9e6679-7425-40de-944b-e07fc1f90ae7","date":"2026-11-05","description":"IFOOD","amountCents":4250,
                   "direction":"debit","status":"posted","isSpending":true,"isInternalTransfer":false,"isCardBillPayment":false,
                   "categoryId":"comida","categorySource":"manual","taxableIncome":"no","deductibleType":null,
                   "account":{"id":"a1","name":"Cartão","type":"credit_card","numberLast4":"9876"}}],
         "nextCursor":null}
        """
        let page = try APIClient.decoder.decode(TransactionPage.self, from: Data(json.utf8))
        XCTAssertEqual(page.items.count, 1)
        XCTAssertTrue(page.items[0].isManual)
        XCTAssertNil(page.nextCursor)
    }

    func testEncodesCorrectionWithBackendFieldNames() throws {
        let data = try JSONEncoder().encode(CategoryCorrection(categoryId: .contasFixas, applyToFuture: true, includePast: false))
        let obj = try JSONSerialization.jsonObject(with: data) as! [String: Any]
        XCTAssertEqual(obj["categoryId"] as? String, "contas_fixas")
        XCTAssertEqual(obj["applyToFuture"] as? Bool, true)
        XCTAssertEqual(obj["includePast"] as? Bool, false)
    }
}
