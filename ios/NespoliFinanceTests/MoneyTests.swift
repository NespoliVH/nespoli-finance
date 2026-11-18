import XCTest
@testable import NespoliFinance

final class MoneyTests: XCTestCase {
    func testFormatsReaisWithThousandsAndCents() {
        XCTAssertEqual(Money.format(123_456_78), "R$ 123.456,78")
        XCTAssertEqual(Money.format(98_000), "R$ 980,00")
        XCTAssertEqual(Money.format(5), "R$ 0,05")
        XCTAssertEqual(Money.format(0), "R$ 0,00")
        XCTAssertEqual(Money.format(-1_050), "-R$ 10,50")
        XCTAssertEqual(Money.format(100_000_000), "R$ 1.000.000,00")
    }

    func testPercentFromBasisPoints() {
        XCTAssertEqual(Money.percent(basisPoints: 4235), "42%")
        XCTAssertEqual(Money.percent(basisPoints: 4250), "43%")
        XCTAssertEqual(Money.percent(basisPoints: 0), "0%")
        XCTAssertEqual(Money.percent(basisPoints: 10_000), "100%")
    }
}
