import XCTest
@testable import NespoliFinance

/// IR para autônomos (seção 4.8.1): perfil, marcações e carnê-leão.
final class SelfEmployedTaxTests: XCTestCase {
    func testOldProfileWithoutIncomeTypeIsSalaried() throws {
        let json = Data(#"{"grossMonthlySalaryCents":500000,"withheldMonthlyCents":null,"dependentsCount":1}"#.utf8)
        let profile = try APIClient.decoder.decode(TaxProfile.self, from: json)
        XCTAssertEqual(profile.incomeType, .salaried)
        XCTAssertEqual(profile.inssPlan, .standard)
    }

    func testProfileEncodesIncomeTypeForBackend() throws {
        let profile = TaxProfile(grossMonthlySalaryCents: 0, withheldMonthlyCents: nil, dependentsCount: 0, incomeType: .selfEmployed, inssPlan: .simplified)
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(profile)) as? [String: Any]
        XCTAssertEqual(object?["incomeType"] as? String, "self_employed")
        XCTAssertEqual(object?["inssPlan"] as? String, "simplified")
    }

    private func encoded(_ mark: TaxMark) throws -> [String: Any] {
        let data = try JSONEncoder().encode(mark)
        return try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
    }

    func testTaxMarkSendsOnlyWhatChanges() throws {
        let income = try encoded(TaxMark(taxableIncome: "confirmed", incomeSource: .some("company"), deductibleType: nil))
        XCTAssertEqual(income["taxableIncome"] as? String, "confirmed")
        XCTAssertEqual(income["incomeSource"] as? String, "company")
        XCTAssertNil(income["deductibleType"])

        let clear = try encoded(TaxMark(taxableIncome: nil, incomeSource: nil, deductibleType: .some(nil)))
        XCTAssertEqual(Array(clear.keys), ["deductibleType"])
        XCTAssertTrue(clear["deductibleType"] is NSNull)
    }

    func testMarkFromScreen() {
        let credit = Transaction(id: "1", date: "2026-11-05", description: "PIX", amountCents: 100, direction: .credit, status: "posted",
                                 isSpending: false, categoryId: nil, categorySource: nil,
                                 account: AccountRef(id: "a", name: "Conta", type: "checking", numberLast4: nil))
        XCTAssertEqual(TaxMarkView.mark(for: credit, isIncome: true, source: "individual", deductible: ""),
                       TaxMark(taxableIncome: "confirmed", incomeSource: .some("individual"), deductibleType: nil))
        XCTAssertEqual(TaxMarkView.mark(for: credit, isIncome: false, source: "individual", deductible: ""),
                       TaxMark(taxableIncome: "no", incomeSource: .some(nil), deductibleType: nil))
    }

    func testDecodesCarneLeaoFromBackend() throws {
        let json = Data("""
        {"year":2026,"incomeType":"self_employed","disclaimer":"x","tableVerifiedOfficial":true,
         "estimate":{"year":2026,"taxableIncomeCents":7200000,"regime":"complete","taxDueCents":195582,"withheldCents":0,
           "carneLeaoPaidCents":134712,"differenceCents":60870,"steps":[],"alternative":{"regime":"simplified","taxDueCents":338701}},
         "monthlyReserveCents":10145,"monthsUntilDeadline":7,
         "inputs":{"otherIncomeSoFarCents":0},
         "carneLeao":{"darfCode":"0190","totalSoFarCents":11226,"projectedAnnualCents":134712,"months":[
           {"month":"2026-03","fromIndividualsCents":600000,"fromCompaniesCents":0,"inssPaidCents":120000,"inssWithheldCents":0,
            "bookExpensesCents":50000,"bookDeductionCents":50000,"bookCarryOverCents":0,"dependentsCents":0,"deductionKind":"legal",
            "deductionCents":170000,"baseCents":430000,"taxBeforeReductionCents":29201,"reductionCents":17975,"taxCents":11226,
            "payableCents":11226,"dueDate":"2026-04-30"}]}}
        """.utf8)
        let r = try APIClient.decoder.decode(TaxEstimateResponse.self, from: json)
        XCTAssertEqual(r.incomeType, .selfEmployed)
        XCTAssertEqual(r.estimate.carneLeaoPaidCents, 134_712)
        XCTAssertEqual(r.carneLeao?.months.first?.taxCents, 11_226)
        XCTAssertEqual(r.carneLeao?.months.first?.dueDate, "2026-04-30")
    }

    func testSalariedResponseHasNoCarneLeao() throws {
        let json = Data("""
        {"year":2026,"incomeType":"salaried","disclaimer":"x","tableVerifiedOfficial":true,
         "estimate":{"year":2026,"taxableIncomeCents":0,"regime":"simplified","taxDueCents":0,"withheldCents":0,
           "carneLeaoPaidCents":0,"differenceCents":0,"steps":[],"alternative":{"regime":"complete","taxDueCents":0}},
         "monthlyReserveCents":0,"monthsUntilDeadline":7,"carneLeao":null}
        """.utf8)
        XCTAssertNil(try APIClient.decoder.decode(TaxEstimateResponse.self, from: json).carneLeao)
    }

    func testDueDateIsLastBusinessDayOfNextMonth() {
        XCTAssertEqual(DemoFinanceRepository.carneLeaoDueDate("2026-01"), "2026-02-27")
        XCTAssertEqual(DemoFinanceRepository.carneLeaoDueDate("2026-03"), "2026-04-30")
        XCTAssertEqual(DemoFinanceRepository.carneLeaoDueDate("2026-12"), "2027-01-29")
    }

    func testNextCarneLeaoAndMonthNames() {
        func m(_ month: String, _ payable: Cents, _ due: String?) -> CarneLeaoMonth {
            CarneLeaoMonth(month: month, fromIndividualsCents: 1, fromCompaniesCents: 0, inssPaidCents: 0, inssWithheldCents: 0,
                           bookDeductionCents: 0, deductionKind: "legal", deductionCents: 0, baseCents: 0, taxCents: payable,
                           payableCents: payable, dueDate: due)
        }
        let c = CarneLeao(darfCode: "0190", months: [m("2026-09", 100, "2026-10-30"), m("2026-10", 0, nil), m("2026-11", 200, "2026-12-31")],
                          totalSoFarCents: 300, projectedAnnualCents: 300)
        XCTAssertEqual(TaxViewModel.nextCarneLeao(c, today: "2026-11-19")?.month, "2026-11")
        XCTAssertEqual(TaxViewModel.nextCarneLeao(c, today: "2026-10-01")?.month, "2026-09")
        XCTAssertNil(TaxViewModel.nextCarneLeao(c, today: "2027-01-01"))
        XCTAssertEqual(TaxViewModel.monthName("2026-03"), "março de 2026")
        XCTAssertEqual(TaxViewModel.shortDay("2026-04-30"), "30/04")
    }

    @MainActor
    func testDemoSelfEmployedEstimateMatchesBackendExample() async {
        let repo = DemoFinanceRepository(month: "2026-11")
        let model = TaxViewModel(repository: repo, isDemo: true)
        await model.save(TaxProfile(grossMonthlySalaryCents: 0, withheldMonthlyCents: nil, dependentsCount: 0, incomeType: .selfEmployed))
        guard case .loaded(let r) = model.state else { return XCTFail("deveria carregar") }
        XCTAssertEqual(r.carneLeao?.months.count, 11)
        XCTAssertEqual(r.carneLeao?.months.first?.taxCents, 11_226)
        XCTAssertEqual(r.estimate.taxDueCents, 195_582)
        XCTAssertEqual(r.estimate.differenceCents, 60_870)
        XCTAssertEqual(model.profile?.incomeType, .selfEmployed)
    }

    @MainActor
    func testMarkTaxInDemoTransactions() async throws {
        let repo = DemoFinanceRepository(month: "2026-11")
        let model = TransactionsViewModel(repository: repo, month: "2026-11", taxRepository: repo)
        await model.reload()
        let pix = try XCTUnwrap(model.items.first { $0.id == "d12" })
        await model.markTax(pix, TaxMark(taxableIncome: "confirmed", incomeSource: .some("individual"), deductibleType: nil))
        let marked = try XCTUnwrap(model.items.first { $0.id == "d12" })
        XCTAssertTrue(marked.isConfirmedIncome)
        XCTAssertEqual(marked.incomeSource, "individual")
        XCTAssertNotNil(model.notice)

        let paper = try XCTUnwrap(model.items.first { $0.id == "d08" })
        await model.markTax(paper, TaxMark(taxableIncome: nil, incomeSource: nil, deductibleType: .some("business")))
        XCTAssertEqual(model.items.first { $0.id == "d08" }?.deductibleType, "business")

        await model.markTax(paper, TaxMark(taxableIncome: "confirmed", incomeSource: nil, deductibleType: nil))
        XCTAssertNotNil(model.errorMessage)
    }
}
