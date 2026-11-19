import XCTest
@testable import NespoliFinance

/// Cofre em memória: o Keychain do simulador não funciona sem assinatura.
final class InMemorySecretStore: SecretStore {
    private var values: [String: String] = [:]
    func set(_ value: String, for key: String) throws { values[key] = value }
    func get(_ key: String) -> String? { values[key] }
    func delete(_ key: String) { values[key] = nil }
}

private func stubSession() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubProtocol.self]
    return URLSession(configuration: config)
}

private func json(_ text: String) -> Data { Data(text.utf8) }

private let base = URL(string: "https://api.exemplo")!
private let tokensJSON = #"{"accessToken":"novo-acesso","refreshToken":"nova-renovacao","expiresIn":900}"#
private let signInJSON = #"{"accessToken":"a1","refreshToken":"r1","expiresIn":900,"isNewUser":true,"user":{"id":"u1","name":"Ana Souza","email":"ana@exemplo.com"}}"#

final class NonceTests: XCTestCase {
    func testRandomNonceUsesSafeCharactersAndChanges() {
        let a = Nonce.random(), b = Nonce.random()
        XCTAssertEqual(a.count, 32)
        XCTAssertNotEqual(a, b)
        let allowed = CharacterSet(charactersIn: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._")
        XCTAssertTrue(a.unicodeScalars.allSatisfy { allowed.contains($0) })
    }

    func testSha256MatchesKnownValue() {
        // Valor de referência do SHA-256 para "abc" (FIPS 180-2), o mesmo que o backend calcula.
        XCTAssertEqual(Nonce.sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }
}

final class SessionStoreTests: XCTestCase {
    func testSaveAndClear() throws {
        let store = SessionStore(store: InMemorySecretStore())
        XCTAssertFalse(store.hasSession)
        try store.save(SessionTokens(accessToken: "a", refreshToken: "r", expiresIn: 900))
        XCTAssertEqual(store.accessToken, "a")
        XCTAssertEqual(store.refreshToken, "r")
        XCTAssertTrue(store.hasSession)
        store.clear()
        XCTAssertNil(store.accessToken)
        XCTAssertFalse(store.hasSession)
    }
}

final class APIClientRefreshTests: XCTestCase {
    private let summaryJSON = json(#"{"month":"2026-11","totalCents":100,"categories":[],"unreadAlerts":0,"connections":{"count":0,"importing":false,"oldestSyncAt":null}}"#)

    override func setUp() { StubProtocol.requests = [] }

    func testRefreshesOnceAndRetriesWithNewToken() async throws {
        var token = "velho"
        var refreshes = 0
        let api = APIClient(baseURL: base, session: stubSession(), cache: ResponseCache(directory: nil),
                            tokenProvider: { token }, refresher: { refreshes += 1; token = "novo"; return .refreshed })
        StubProtocol.handler = { req in
            req.value(forHTTPHeaderField: "Authorization") == "Bearer novo" ? (200, [:], self.summaryJSON) : (401, [:], Data())
        }
        let summary: MonthSummary = try await api.get("summary")
        XCTAssertEqual(summary.totalCents, 100)
        XCTAssertEqual(refreshes, 1)
        XCTAssertEqual(StubProtocol.requests.map { $0.value(forHTTPHeaderField: "Authorization") }, ["Bearer velho", "Bearer novo"])
    }

    func testRejectedRefreshSurfacesUnauthorized() async {
        let api = APIClient(baseURL: base, session: stubSession(), cache: ResponseCache(directory: nil),
                            tokenProvider: { "velho" }, refresher: { .rejected })
        StubProtocol.handler = { _ in (401, [:], Data()) }
        do {
            let _: MonthSummary = try await api.get("summary")
            XCTFail("deveria falhar")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized)
        }
        XCTAssertEqual(StubProtocol.requests.count, 1)
    }

    func testSecond401AfterRefreshDoesNotLoop() async {
        var refreshes = 0
        let api = APIClient(baseURL: base, session: stubSession(), cache: ResponseCache(directory: nil),
                            tokenProvider: { "x" }, refresher: { refreshes += 1; return .refreshed })
        StubProtocol.handler = { _ in (401, [:], Data()) }
        do {
            try await api.sendNoContent("POST", "alerts/1/read", body: Optional<[String: String]>.none)
            XCTFail("deveria falhar")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized)
        }
        XCTAssertEqual(refreshes, 1)
        XCTAssertEqual(StubProtocol.requests.count, 2)
    }
}

final class AuthServiceTests: XCTestCase {
    private var store: SessionStore!
    private var auth: AuthService!

    override func setUp() {
        StubProtocol.requests = []
        store = SessionStore(store: InMemorySecretStore())
        auth = AuthService(baseURL: base, session: stubSession(), store: store)
    }

    private func body(_ request: URLRequest) -> [String: Any] {
        // URLProtocol recebe o corpo como stream.
        guard let stream = request.httpBodyStream else { return [:] }
        stream.open(); defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            data.append(buffer, count: n)
        }
        return (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    func testSignInSendsNonceAndNameAndSavesTokens() async throws {
        StubProtocol.handler = { _ in (201, [:], json(signInJSON)) }
        let result = try await auth.signIn(AppleSignInRequest(identityToken: "jwt", rawNonce: "nonce-original-1234",
                                                              fullName: .init(givenName: "Ana", familyName: "Souza")))
        XCTAssertTrue(result.isNewUser)
        XCTAssertEqual(store.accessToken, "a1")
        XCTAssertEqual(store.refreshToken, "r1")
        let request = try XCTUnwrap(StubProtocol.requests.first)
        XCTAssertEqual(request.url?.path, "/auth/apple")
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
        let sent = body(request)
        XCTAssertEqual(sent["rawNonce"] as? String, "nonce-original-1234")
        XCTAssertEqual((sent["fullName"] as? [String: Any])?["givenName"] as? String, "Ana")
    }

    func testRefreshSavesNewPair() async throws {
        try store.save(SessionTokens(accessToken: "a", refreshToken: "r", expiresIn: 900))
        StubProtocol.handler = { _ in (200, [:], json(tokensJSON)) }
        let outcome = await auth.refresh()
        XCTAssertEqual(outcome, .refreshed)
        XCTAssertEqual(store.refreshToken, "nova-renovacao")
        XCTAssertEqual(body(StubProtocol.requests[0])["refreshToken"] as? String, "r")
    }

    func testRejectedRefreshClearsSession() async throws {
        try store.save(SessionTokens(accessToken: "a", refreshToken: "r", expiresIn: 900))
        StubProtocol.handler = { _ in (401, [:], json(#"{"error":"invalid_refresh_token"}"#)) }
        let outcome = await auth.refresh()
        XCTAssertEqual(outcome, .rejected)
        XCTAssertFalse(store.hasSession)
    }

    func testOfflineRefreshKeepsSession() async throws {
        try store.save(SessionTokens(accessToken: "a", refreshToken: "r", expiresIn: 900))
        StubProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        let outcome = await auth.refresh()
        XCTAssertEqual(outcome, .unavailable)
        XCTAssertTrue(store.hasSession)
    }

    func testConcurrentRefreshesShareOneRequest() async throws {
        try store.save(SessionTokens(accessToken: "a", refreshToken: "r", expiresIn: 900))
        StubProtocol.handler = { _ in
            Thread.sleep(forTimeInterval: 0.2)
            return (200, [:], json(tokensJSON))
        }
        async let first = auth.refresh()
        async let second = auth.refresh()
        let outcomes = await [first, second]
        XCTAssertEqual(outcomes, [.refreshed, .refreshed])
        XCTAssertEqual(StubProtocol.requests.count, 1)
    }

    func testSignOutRevokesAndClearsEvenOffline() async throws {
        try store.save(SessionTokens(accessToken: "a", refreshToken: "r", expiresIn: 900))
        StubProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        await auth.signOut()
        XCTAssertFalse(store.hasSession)
        XCTAssertEqual(StubProtocol.requests.first?.url?.path, "/auth/logout")
        XCTAssertEqual(StubProtocol.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer a")
    }
}

@MainActor
final class SessionModelTests: XCTestCase {
    private var store: SessionStore!
    private var defaults: UserDefaults!

    override func setUp() {
        StubProtocol.requests = []
        store = SessionStore(store: InMemorySecretStore())
        defaults = UserDefaults(suiteName: "testes-\(UUID().uuidString)")!
    }

    private func model(baseURL: URL? = base) -> SessionModel {
        SessionModel(baseURL: baseURL, store: store, defaults: defaults, urlSession: stubSession())
    }

    func testStartsSignedOutThenDemoIsRemembered() {
        let first = model()
        XCTAssertEqual(first.state, .signedOut)
        XCTAssertNil(first.environment)
        first.startDemo()
        XCTAssertEqual(first.state, .demo)
        XCTAssertEqual(first.environment?.isDemo, true)
        XCTAssertEqual(model().state, .demo)
    }

    func testStoredSessionOpensSignedIn() throws {
        try store.save(SessionTokens(accessToken: "a", refreshToken: "r", expiresIn: 900))
        let m = model()
        XCTAssertEqual(m.state, .signedIn)
        XCTAssertEqual(m.environment?.isDemo, false)
    }

    func testStoredSessionWithoutServerStaysSignedOut() throws {
        try store.save(SessionTokens(accessToken: "a", refreshToken: "r", expiresIn: 900))
        XCTAssertEqual(model(baseURL: nil).state, .signedOut)
    }

    func testAppleSignInSendsRawNonceAndEntersLiveMode() async throws {
        StubProtocol.handler = { _ in (201, [:], json(signInJSON)) }
        let m = model()
        let hashed = m.prepareAppleRequest()
        XCTAssertEqual(hashed.count, 64)
        await m.completeApple(identityToken: Data("jwt".utf8), givenName: "Ana", familyName: nil)
        XCTAssertEqual(m.state, .signedIn)
        XCTAssertEqual(store.accessToken, "a1")
        XCTAssertNil(m.errorMessage)
    }

    func testCompleteWithoutPreparedNonceIsRejected() async {
        let m = model()
        await m.completeApple(identityToken: Data("jwt".utf8), givenName: nil, familyName: nil)
        XCTAssertEqual(m.state, .signedOut)
        XCTAssertNotNil(m.errorMessage)
        XCTAssertTrue(StubProtocol.requests.isEmpty)
    }

    func testRejectedAppleTokenShowsMessage() async {
        StubProtocol.handler = { _ in (401, [:], json(#"{"error":"invalid_apple_token"}"#)) }
        let m = model()
        _ = m.prepareAppleRequest()
        await m.completeApple(identityToken: Data("jwt".utf8), givenName: nil, familyName: nil)
        XCTAssertEqual(m.state, .signedOut)
        XCTAssertEqual(m.errorMessage, SessionModel.signInMessage(for: APIError.unauthorized))
        XCTAssertFalse(store.hasSession)
    }

    func testWithoutServerExplainsDemo() async {
        let m = model(baseURL: nil)
        _ = m.prepareAppleRequest()
        await m.completeApple(identityToken: Data("jwt".utf8), givenName: nil, familyName: nil)
        XCTAssertEqual(m.state, .signedOut)
        XCTAssertTrue(m.errorMessage?.contains("demonstração") ?? false)
    }

    func testCancelIsNotAnError() {
        let m = model()
        m.appleFailed(canceled: true)
        XCTAssertNil(m.errorMessage)
    }

    func testSignOutCallsLogoutAndClears() async throws {
        try store.save(SessionTokens(accessToken: "a", refreshToken: "r", expiresIn: 900))
        StubProtocol.handler = { _ in (204, [:], Data()) }
        let m = model()
        await m.signOut()
        XCTAssertEqual(m.state, .signedOut)
        XCTAssertFalse(store.hasSession)
        XCTAssertEqual(StubProtocol.requests.map { $0.url?.path }, ["/auth/logout"])
    }

    func testAccountDeletedShowsNotice() throws {
        try store.save(SessionTokens(accessToken: "a", refreshToken: "r", expiresIn: 900))
        let m = model()
        m.accountDeleted()
        XCTAssertEqual(m.state, .signedOut)
        XCTAssertFalse(store.hasSession)
        XCTAssertNotNil(m.notice)
    }

    func testRejectedRefreshDuringUseReturnsToSignIn() async throws {
        try store.save(SessionTokens(accessToken: "a", refreshToken: "r", expiresIn: 900))
        StubProtocol.handler = { _ in (401, [:], Data()) }
        let m = model()
        do {
            _ = try await m.environment!.repository.summary(month: "2026-11")
            XCTFail("deveria falhar")
        } catch {
            XCTAssertEqual(error as? APIError, .unauthorized)
        }
        XCTAssertEqual(m.state, .signedOut)
        XCTAssertEqual(m.notice, APIError.unauthorized.message)
        XCTAssertEqual(StubProtocol.requests.map { $0.url?.path }, ["/summary", "/auth/refresh"])
    }

    func testDemoSignOutReturnsToEntryWithoutCallingServer() async {
        let m = model()
        m.startDemo()
        await m.signOut()
        XCTAssertEqual(m.state, .signedOut)
        XCTAssertEqual(model().state, .signedOut)
        XCTAssertTrue(StubProtocol.requests.isEmpty)
    }
}

final class BiometricLockTests: XCTestCase {
    func testLocksOnlyWhenAllConditionsHold() {
        XCTAssertTrue(BiometricLock.shouldLock(enabled: true, required: true, locked: true, available: true))
        XCTAssertFalse(BiometricLock.shouldLock(enabled: false, required: true, locked: true, available: true))
        XCTAssertFalse(BiometricLock.shouldLock(enabled: true, required: false, locked: true, available: true))
        XCTAssertFalse(BiometricLock.shouldLock(enabled: true, required: true, locked: false, available: true))
        XCTAssertFalse(BiometricLock.shouldLock(enabled: true, required: true, locked: true, available: false))
    }
}
