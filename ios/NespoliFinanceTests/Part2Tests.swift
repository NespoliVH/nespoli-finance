import XCTest
@testable import NespoliFinance

/// Alertas, IR e ajustes (parte 2).
@MainActor
final class Part2Tests: XCTestCase {
    // MARK: Alertas

    func testAlertsLoadNewestFirstAndMarkRead() async {
        let model = AlertsViewModel(repository: DemoFinanceRepository(month: "2026-11"))
        await model.load()
        XCTAssertEqual(model.alerts.map(\.id), ["a1", "a0"])
        XCTAssertEqual(model.unreadCount, 1)
        await model.open(model.alerts[0])
        XCTAssertEqual(model.unreadCount, 0)
    }

    func testMarkReadRollsBackWhenServerFails() async {
        let repo = FlakyAlerts()
        let model = AlertsViewModel(repository: repo)
        await model.load()
        await model.open(model.alerts[0])
        XCTAssertEqual(model.unreadCount, 1, "volta a não lido se o backend recusar")
    }

    func testAlertSentence() {
        let a = SpendingAlert(id: "x", month: "2026-11", category: CategoryRef(id: .comida, name: "Comida", icon: "fork.knife"),
                              currentCents: 98_000, averageCents: 69_000, increasePct: 42.03, read: false, createdAt: Date())
        XCTAssertEqual(AlertsViewModel.sentence(a), "R$ 980,00 este mês, 42% acima da sua média de R$ 690,00.")
    }

    func testDecodesAlertListFromBackend() throws {
        let json = """
        {"items":[{"id":"a1","month":"2026-11","category":{"id":"comida","name":"Comida","icon":"fork.knife"},
                   "currentCents":98000,"averageCents":69000,"increasePct":42.03,"read":false,"createdAt":"2026-11-18T12:00:00.000Z"}]}
        """
        let list = try APIClient.decoder.decode(AlertList.self, from: Data(json.utf8))
        XCTAssertEqual(list.items.first?.increasePct, 42.03)
    }

    // MARK: IR

    func testTaxEstimateMatchesBackendExample() async {
        let model = TaxViewModel(repository: DemoFinanceRepository(month: "2026-11"), isDemo: true)
        await model.load()
        guard case .loaded(let r) = model.state else { return XCTFail("não carregou") }
        XCTAssertEqual(r.estimate.taxDueCents, 1_748_780)
        XCTAssertEqual(r.monthsUntilDeadline, 7) // novembro a maio
        XCTAssertEqual(r.monthlyReserveCents, 249_826) // 17.487,80 ÷ 7, para cima
        XCTAssertFalse(r.tableVerifiedOfficial)
        XCTAssertEqual(TaxViewModel.headline(r.estimate), "Você deve pagar cerca de R$ 17.487,80 na declaração.")
    }

    func testWithoutProfileAsksForIt() async {
        let repo = DemoFinanceRepository(month: "2026-11")
        await repo.resetDemo()
        let model = TaxViewModel(repository: repo, isDemo: true)
        await model.load()
        XCTAssertEqual(model.state, .needsProfile)
        await model.save(TaxProfile(grossMonthlySalaryCents: 750_000, withheldMonthlyCents: nil, dependentsCount: 1))
        guard case .loaded = model.state else { return XCTFail("deveria calcular depois do perfil") }
        XCTAssertEqual(model.profile?.dependentsCount, 1)
    }

    func testBackend409MeansProfileRequired() async {
        let model = TaxViewModel(repository: FailingRepository(error: .server(status: 409, code: "profile_required")), isDemo: false)
        await model.load()
        XCTAssertEqual(model.state, .failed(APIError.server(status: 409, code: "profile_required").message),
                       "taxProfile falhou antes; só o 409 da estimativa vira pedido de perfil")
    }

    func testRefundHeadline() {
        let e = TaxEstimate(year: 2026, taxableIncomeCents: 0, regime: "simplified", taxDueCents: 0, withheldCents: 50_000,
                            differenceCents: -50_000, steps: [], alternative: .init(regime: "complete", taxDueCents: 0))
        XCTAssertEqual(TaxViewModel.headline(e), "Você deve receber cerca de R$ 500,00 de restituição.")
    }

    func testParsesTypedReais() {
        XCTAssertEqual(TaxViewModel.parseReais("7.500,00"), 750_000)
        XCTAssertEqual(TaxViewModel.parseReais("7500"), 750_000)
        XCTAssertEqual(TaxViewModel.parseReais("7500,5"), 750_050)
        XCTAssertEqual(TaxViewModel.parseReais("R$ 1.234,56"), 123_456)
        XCTAssertNil(TaxViewModel.parseReais("abc"))
        XCTAssertNil(TaxViewModel.parseReais("10,123"))
        XCTAssertEqual(TaxViewModel.editable(750_050), "7500,50")
    }

    func testMonthsUntilDeadline() {
        XCTAssertEqual(DemoFinanceRepository.monthsUntilDeadline(month: "2026-11", deadlineMonth: 5), 7)
        XCTAssertEqual(DemoFinanceRepository.monthsUntilDeadline(month: "2026-01", deadlineMonth: 5), 17)
    }

    // MARK: Ajustes

    func testDeleteNeedsTheTypedWord() async {
        XCTAssertTrue(SettingsViewModel.canDelete(typed: "excluir "))
        XCTAssertFalse(SettingsViewModel.canDelete(typed: "sim"))
        let model = SettingsViewModel(repository: DemoFinanceRepository(month: "2026-11"), isDemo: true)
        await model.load()
        await model.deleteAccount(typed: "sim")
        XCTAssertFalse(model.deleted)
        await model.deleteAccount(typed: "EXCLUIR")
        XCTAssertTrue(model.deleted)
    }

    func testDeleteFailureShowsRetryMessage() async {
        let model = SettingsViewModel(repository: FailingRepository(error: .server(status: 502, code: "pluggy_unavailable")), isDemo: false)
        await model.deleteAccount(typed: "EXCLUIR")
        XCTAssertFalse(model.deleted)
        XCTAssertEqual(model.errorMessage, "O serviço do banco não respondeu. Tente de novo em alguns minutos.")
    }

    func testSettingsLoadsConsents() async {
        let model = SettingsViewModel(repository: DemoFinanceRepository(month: "2026-11"), isDemo: true)
        await model.load()
        XCTAssertEqual(model.consents.map(\.type), ["privacy_policy", "bank_data_sharing"])
        XCTAssertEqual(model.consents[1].title, "Dados do banco (Banco de demonstração)")
    }
}

/// Alertas que carregam, mas o backend recusa marcar como lido.
struct FlakyAlerts: AlertsRepository {
    func alerts() async throws -> [SpendingAlert] {
        [SpendingAlert(id: "a", month: "2026-11", category: CategoryRef(id: .comida, name: "Comida", icon: "fork.knife"),
                       currentCents: 1, averageCents: 1, increasePct: 1, read: false, createdAt: Date())]
    }
    func markRead(alertID: String) async throws { throw APIError.offline }
    func markAllRead() async throws { throw APIError.offline }
}
