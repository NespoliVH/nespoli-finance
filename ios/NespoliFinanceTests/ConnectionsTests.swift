import XCTest
@testable import NespoliFinance

/// Conexão bancária: protocolo do Pluggy Connect, modelos e a tela.
@MainActor
final class ConnectionsTests: XCTestCase {
    // MARK: Mensagens do Pluggy Connect

    func testSuccessGivesTheItemID() {
        var parser = PluggyConnect.LocationParser()
        let event = parser.parse("?events=OPEN,SUBMITTED_LOGIN,SUCCESS&item_id=abc-123&timestamp=10&item_status=UPDATED")
        XCTAssertEqual(event, .success(itemID: "abc-123"))
    }

    func testRepeatedTimestampIsIgnored() {
        var parser = PluggyConnect.LocationParser()
        XCTAssertEqual(parser.parse("events=OPEN&timestamp=1"), .open)
        XCTAssertNil(parser.parse("events=OPEN&timestamp=1"))
        XCTAssertEqual(parser.parse("events=OPEN,CLOSE&timestamp=2"), .close)
    }

    func testErrorAndIntermediateSteps() {
        var parser = PluggyConnect.LocationParser()
        XCTAssertEqual(parser.parse("events=ERROR&error=Senha%20inv%C3%A1lida&timestamp=1"), .error(message: "Senha inválida", itemID: nil))
        XCTAssertEqual(parser.parse("events=SELECTED_INSTITUTION&connector_id=2&timestamp=2"), .step("SELECTED_INSTITUTION"))
        XCTAssertNil(parser.parse("item_id=x&timestamp=3"))
    }

    func testSuccessWithoutItemIsAnError() {
        var parser = PluggyConnect.LocationParser()
        if case .error = parser.parse("events=SUCCESS&timestamp=1") {} else { XCTFail("esperava erro") }
    }

    func testBridgeMessageDecoding() {
        XCTAssertEqual(PluggyConnect.BridgeMessage.decode(#"{"type":"LOCATION","message":"?events=OPEN"}"#),
                       .init(type: "LOCATION", message: "?events=OPEN"))
        XCTAssertNil(PluggyConnect.BridgeMessage.decode("não é json"))
        XCTAssertNil(PluggyConnect.BridgeMessage.decode(42))
    }

    func testConnectURL() throws {
        let novo = PluggyConnect.url(token: ConnectToken(accessToken: "tok", updateItem: nil), includeSandbox: true)
        let items = try XCTUnwrap(URLComponents(url: novo, resolvingAgainstBaseURL: false)?.queryItems)
        XCTAssertEqual(novo.host, "connect.pluggy.ai")
        XCTAssertTrue(items.contains(URLQueryItem(name: "connect_token", value: "tok")))
        XCTAssertTrue(items.contains(URLQueryItem(name: "with_sandbox", value: "true")))
        XCTAssertFalse(items.contains { $0.name == "update_item" })

        let reconectar = PluggyConnect.url(token: ConnectToken(accessToken: "tok", updateItem: "item-9"), includeSandbox: false)
        XCTAssertTrue(reconectar.absoluteString.contains("update_item=item-9"))
        XCTAssertTrue(reconectar.absoluteString.contains("with_sandbox=false"))
    }

    // MARK: Modelos

    func testDecodesConnectionsAndUnknownStatus() throws {
        let json = #"""
        [{"id":"c1","institutionName":"Banco X","status":"login_error","consentExpiresAt":"2027-01-01T00:00:00.000Z",
          "lastSyncedAt":null,"accounts":[{"id":"a1","type":"credit_card","name":"Cartão","numberLast4":"1234","balanceCents":-5000}]},
         {"id":"c2","institutionName":"Banco Y","status":"algo_novo","consentExpiresAt":null,"lastSyncedAt":null,"accounts":[]}]
        """#
        let list = try APIClient.decoder.decode([BankConnection].self, from: Data(json.utf8))
        XCTAssertEqual(list[0].status, .loginError)
        XCTAssertTrue(list[0].status.needsReconnect)
        XCTAssertEqual(list[0].accounts[0].typeLabel, "Cartão de crédito")
        XCTAssertEqual(list[1].status, .unknown)
    }

    // MARK: Tela, modo demonstração

    func testDemoConnectsWithoutPluggy() async {
        let model = ConnectionsViewModel(repository: DemoFinanceRepository(month: "2026-11"), appVersion: "0.1.0")
        await model.load()
        XCTAssertEqual(model.connections.count, 2)
        model.beginConnect()
        await model.acceptConsent()
        XCTAssertNil(model.flow)
        XCTAssertEqual(model.connections.count, 3)
        XCTAssertNotNil(model.notice)
    }

    func testDemoBanksStartUpToDateAndDisconnect() async {
        let model = ConnectionsViewModel(repository: DemoFinanceRepository(month: "2026-11"), appVersion: "0.1.0")
        await model.load()
        XCTAssertTrue(model.connections.allSatisfy { $0.status == .active })
        let second = model.connections[1]
        await model.disconnect(second)
        XCTAssertFalse(model.connections.contains { $0.id == second.id })
    }

    // MARK: Tela, com Pluggy

    func testLiveFlowOpensPluggyThenSavesTheItem() async throws {
        let repo = RecordingConnections()
        let model = ConnectionsViewModel(repository: repo, includeSandbox: true, appVersion: "0.2.0")
        model.beginConnect()
        await model.acceptConsent()
        guard case .pluggy(let url)? = model.flow?.stage else { return XCTFail("esperava o Pluggy aberto") }
        XCTAssertTrue(url.absoluteString.contains("connect_token=tok-new"))

        await model.handle(.step("SUBMITTED_LOGIN"))
        XCTAssertNotNil(model.flow)
        await model.handle(.success(itemID: "item-9"))
        XCTAssertNil(model.flow)
        let created = await repo.created
        XCTAssertEqual(created, ["item-9|1.0|0.2.0"])
    }

    func testAlreadyConnectedIsNotAnError() async {
        let repo = RecordingConnections(createError: .server(status: 409, code: "already_connected"))
        let model = ConnectionsViewModel(repository: repo, appVersion: "0.2.0")
        model.beginConnect()
        await model.acceptConsent()
        await model.handle(.success(itemID: "item-9"))
        XCTAssertNil(model.errorMessage)
        XCTAssertNotNil(model.notice)
    }

    func testReconnectUsesTheExistingConnection() async {
        let repo = RecordingConnections()
        let model = ConnectionsViewModel(repository: repo, appVersion: "0.2.0")
        await model.load()
        model.beginReconnect(model.connections[0])
        await model.acceptConsent()
        guard case .pluggy(let url)? = model.flow?.stage else { return XCTFail("esperava o Pluggy aberto") }
        XCTAssertTrue(url.absoluteString.contains("update_item=item-c1"))
        await model.handle(.success(itemID: "item-c1"))
        let reconnected = await repo.reconnectedIDs
        let created = await repo.created
        XCTAssertEqual(reconnected, ["c1"])
        XCTAssertTrue(created.isEmpty)
    }

    func testClosingPluggyCancelsAndTokenFailureShowsMessage() async {
        let ok = ConnectionsViewModel(repository: RecordingConnections(), appVersion: "0.2.0")
        ok.beginConnect()
        await ok.acceptConsent()
        await ok.handle(.close)
        XCTAssertNil(ok.flow)

        let failing = ConnectionsViewModel(repository: FailingRepository(error: .server(status: 503, code: "pluggy_not_configured")), appVersion: "0.2.0")
        failing.beginConnect()
        await failing.acceptConsent()
        XCTAssertNil(failing.flow)
        XCTAssertEqual(failing.errorMessage, "A conexão com bancos ainda não está disponível no servidor.")
    }
}

/// Repositório falso que grava as chamadas, como se fosse o backend real.
actor RecordingConnections: ConnectionsRepository {
    private(set) var created: [String] = []
    private(set) var reconnectedIDs: [String] = []
    let createError: APIError?

    init(createError: APIError? = nil) { self.createError = createError }

    nonisolated var usesPluggyWidget: Bool { true }

    func connections() async throws -> [BankConnection] {
        [BankConnection(id: "c1", institutionName: "Banco X", status: .loginError, consentExpiresAt: nil, lastSyncedAt: nil, accounts: [])]
    }

    func connectToken(connectionID: String?) async throws -> ConnectToken {
        ConnectToken(accessToken: connectionID == nil ? "tok-new" : "tok-update", updateItem: connectionID.map { "item-\($0)" })
    }

    func createConnection(itemID: String, termsVersion: String, appVersion: String) async throws {
        if let createError { throw createError }
        created.append("\(itemID)|\(termsVersion)|\(appVersion)")
    }

    func reconnected(connectionID: String, termsVersion: String, appVersion: String) async throws {
        reconnectedIDs.append(connectionID)
    }

    func syncConnection(connectionID: String) async throws {}
    func deleteConnection(connectionID: String) async throws {}
}
