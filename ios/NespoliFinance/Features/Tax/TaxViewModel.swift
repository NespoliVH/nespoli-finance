import Foundation
import Observation

/// Tela do IR (RF27): perfil fiscal e a estimativa do ano, com passo a passo.
@MainActor
@Observable
final class TaxViewModel {
    enum State: Equatable {
        case loading
        /// Sem perfil fiscal: a tela pede o salário antes de calcular.
        case needsProfile
        case loaded(TaxEstimateResponse)
        case failed(String)
    }

    private(set) var state: State = .loading
    private(set) var profile: TaxProfile?
    let isDemo: Bool
    private let repository: TaxRepository

    init(repository: TaxRepository, isDemo: Bool) {
        self.repository = repository
        self.isDemo = isDemo
    }

    func load() async {
        do {
            profile = try await repository.taxProfile()
            guard profile != nil else { state = .needsProfile; return }
            state = .loaded(try await repository.taxEstimate())
        } catch APIError.server(409, _) {
            state = .needsProfile
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(APIError.invalidResponse.message)
        }
    }

    func save(_ profile: TaxProfile) async {
        do {
            try await repository.saveTaxProfile(profile)
            await load()
        } catch let error as APIError {
            state = .failed(error.message)
        } catch {
            state = .failed(APIError.invalidResponse.message)
        }
    }

    /// Frase do resultado: a pagar, a restituir ou zerado.
    nonisolated static func headline(_ e: TaxEstimate) -> String {
        if e.differenceCents > 0 { return "Você deve pagar cerca de \(Money.format(e.differenceCents)) na declaração." }
        if e.differenceCents < 0 { return "Você deve receber cerca de \(Money.format(-e.differenceCents)) de restituição." }
        return "O imposto retido deve cobrir o devido."
    }

    /// Próximo DARF do carnê-leão a vencer a partir de hoje ("2026-11-19").
    nonisolated static func nextCarneLeao(_ c: CarneLeao, today: String) -> CarneLeaoMonth? {
        c.months.filter { $0.payableCents > 0 && ($0.dueDate ?? "") >= today }.min { ($0.dueDate ?? "") < ($1.dueDate ?? "") }
    }

    /// "2026-03" → "março de 2026".
    nonisolated static func monthName(_ month: String) -> String {
        let names = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"]
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2, (1...12).contains(parts[1]) else { return month }
        return "\(names[parts[1] - 1]) de \(parts[0])"
    }

    /// "2026-04-30" → "30/04".
    nonisolated static func shortDay(_ date: String) -> String {
        let p = date.split(separator: "-")
        guard p.count == 3 else { return date }
        return "\(p[2])/\(p[1])"
    }

    /// Hoje no formato do backend, no fuso de Brasília.
    nonisolated static func todayString(_ now: Date = Date()) -> String {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = TimeZone(identifier: "America/Sao_Paulo")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: now)
    }

    /// Converte o texto digitado ("7.500,00", "7500", "7500,5") em centavos.
    nonisolated static func parseReais(_ text: String) -> Cents? {
        let cleaned = text.replacingOccurrences(of: "R$", with: "").replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: ".", with: "")
        let parts = cleaned.split(separator: ",", omittingEmptySubsequences: false)
        guard parts.count <= 2, let reais = Int(parts[0].isEmpty ? "0" : String(parts[0])), reais >= 0 else { return nil }
        var cents = 0
        if parts.count == 2 {
            let frac = String(parts[1])
            guard frac.count <= 2, frac.allSatisfy(\.isNumber) else { return nil }
            cents = Int(frac.padding(toLength: 2, withPad: "0", startingAt: 0)) ?? 0
        }
        return reais * 100 + cents
    }

    /// Centavos para o campo de texto: 750000 → "7500,00".
    nonisolated static func editable(_ cents: Cents) -> String {
        "\(cents / 100),\(cents % 100 < 10 ? "0" : "")\(cents % 100)"
    }
}
