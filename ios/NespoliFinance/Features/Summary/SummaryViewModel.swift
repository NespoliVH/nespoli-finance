import Foundation
import Observation

/// Estado da tela de resumo do mês (RF20, RF21). A View só desenha o que
/// está aqui; a lógica fica no ViewModel, que dá para testar sem tela (RNF19).
@MainActor
@Observable
final class SummaryViewModel {
    enum State: Equatable {
        case loading
        case loaded(MonthSummary)
        case failed(String)
    }

    private(set) var state: State = .loading
    private(set) var month: String
    private let repository: FinanceRepository

    /// A lista de transações de uma categoria usa a mesma fonte de dados.
    var repositoryForChildren: FinanceRepository { repository }

    init(repository: FinanceRepository, month: String = DemoFinanceRepository.currentMonth()) {
        self.repository = repository
        self.month = month
    }

    func load() async {
        if case .loaded = state {} else { state = .loading }
        do {
            state = .loaded(try await repository.summary(month: month))
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(APIError.invalidResponse.message)
        }
    }

    func goToPreviousMonth() async { month = Self.shift(month, by: -1); state = .loading; await load() }
    func goToNextMonth() async { month = Self.shift(month, by: 1); state = .loading; await load() }

    var canGoForward: Bool { month < DemoFinanceRepository.currentMonth() }

    /// "2026-11" → "novembro de 2026".
    var monthTitle: String { Self.title(month) }

    /// Categorias com gasto, para o gráfico. Categoria zerada não vira fatia.
    var chartSlices: [CategoryTotal] {
        guard case .loaded(let s) = state else { return [] }
        return s.categories.filter { $0.totalCents > 0 }
    }

    static func shift(_ month: String, by delta: Int) -> String {
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2 else { return month }
        let index = parts[0] * 12 + (parts[1] - 1) + delta
        return String(format: "%04d-%02d", index / 12, index % 12 + 1)
    }

    static let monthNames = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho",
                             "agosto", "setembro", "outubro", "novembro", "dezembro"]

    static func title(_ month: String) -> String {
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2, (1...12).contains(parts[1]) else { return month }
        return "\(monthNames[parts[1] - 1]) de \(parts[0])"
    }
}
