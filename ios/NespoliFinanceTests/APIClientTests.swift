import XCTest
@testable import NespoliFinance

/// Servidor falso: responde o que o teste mandar, sem rede.
final class StubProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (Int, [String: String], Data))?
    static var requests: [URLRequest] = []

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requests.append(request)
        do {
            let (status, headers, body) = try Self.handler!(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: body)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }
    override func stopLoading() {}
}

final class APIClientTests: XCTestCase {
    var api: APIClient!

    override func setUp() {
        StubProtocol.requests = []
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        api = APIClient(baseURL: URL(string: "https://api.exemplo")!, session: URLSession(configuration: config),
                        cache: ResponseCache(directory: nil), tokenProvider: { "tok" })
    }

    private let summaryJSON = Data("""
    {"month":"2026-11","totalCents":100,"categories":[],"unreadAlerts":0,"connections":{"count":0,"importing":false,"oldestSyncAt":null}}
    """.utf8)

    func testSendsTokenAndUsesCachedCopyOn304() async throws {
        StubProtocol.handler = { req in
            if req.value(forHTTPHeaderField: "If-None-Match") == "W/\"abc\"" { return (304, [:], Data()) }
            return (200, ["ETag": "W/\"abc\""], self.summaryJSON)
        }
        let first: MonthSummary = try await api.get("summary")
        let second: MonthSummary = try await api.get("summary")
        XCTAssertEqual(first, second)
        XCTAssertEqual(StubProtocol.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(StubProtocol.requests.last?.value(forHTTPHeaderField: "If-None-Match"), "W/\"abc\"")
    }

    func testOfflineFallsBackToLastCopy() async throws {
        StubProtocol.handler = { _ in (200, ["ETag": "W/\"abc\""], self.summaryJSON) }
        let _: MonthSummary = try await api.get("summary")
        StubProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        let offline: MonthSummary = try await api.get("summary")
        XCTAssertEqual(offline.totalCents, 100)
    }

    func testOfflineWithoutCopyIsAnError() async {
        StubProtocol.handler = { _ in throw URLError(.notConnectedToInternet) }
        do {
            let _: MonthSummary = try await api.get("summary")
            XCTFail("deveria falhar")
        } catch {
            XCTAssertEqual(error as? APIError, .offline)
        }
    }

    func testMapsServerErrors() async {
        StubProtocol.handler = { _ in (401, [:], Data()) }
        do { let _: MonthSummary = try await api.get("summary"); XCTFail() } catch { XCTAssertEqual(error as? APIError, .unauthorized) }
        StubProtocol.handler = { _ in (502, [:], Data("{\"error\":\"pluggy_unavailable\"}".utf8)) }
        do { let _: MonthSummary = try await api.get("summary"); XCTFail() } catch {
            XCTAssertEqual(error as? APIError, .server(status: 502, code: "pluggy_unavailable"))
        }
    }

    func testBuildsQueryWithoutEmptyValues() async throws {
        StubProtocol.handler = { _ in (200, [:], Data("{\"items\":[],\"nextCursor\":null}".utf8)) }
        let _: TransactionPage = try await api.get("transactions", query: ["month": "2026-11", "cursor": nil, "kind": "all"])
        XCTAssertEqual(StubProtocol.requests.last?.url?.absoluteString, "https://api.exemplo/transactions?kind=all&month=2026-11")
    }
}
