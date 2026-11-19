import Foundation

/// Modo demonstração para alertas, IR e conta. Mesma ideia da parte 1: dados
/// de exemplo, guardados só na memória.
extension DemoFinanceRepository: AlertsRepository, TaxRepository, AccountRepository {
    func alerts() async throws -> [SpendingAlert] {
        demoAlerts.sorted { $0.createdAt > $1.createdAt }
    }

    func markRead(alertID: String) async throws {
        guard let i = demoAlerts.firstIndex(where: { $0.id == alertID }) else { throw APIError.notFound }
        demoAlerts[i].read = true
    }

    func markAllRead() async throws {
        for i in demoAlerts.indices { demoAlerts[i].read = true }
    }

    func taxProfile() async throws -> TaxProfile? { demoTaxProfile }

    func saveTaxProfile(_ profile: TaxProfile) async throws {
        guard profile.grossMonthlySalaryCents >= 0, profile.dependentsCount >= 0 else {
            throw APIError.server(status: 400, code: "invalid_body")
        }
        demoTaxProfile = profile
    }

    /// No modo demonstração o cálculo não roda: é o exemplo fixo de salário de
    /// R$ 10.000, com os mesmos números que os testes do backend conferem.
    /// Com o perfil de autônomo, o exemplo fixo é o de quem recebe R$ 6.000 por
    /// mês de pessoas físicas, também conferido nos testes do backend.
    func taxEstimate() async throws -> TaxEstimateResponse {
        guard let profile = demoTaxProfile else { throw APIError.server(status: 409, code: "profile_required") }
        let months = Self.monthsUntilDeadline(month: month, deadlineMonth: 5)
        if profile.incomeType.hasSelfEmployment { return Self.selfEmployedExample(month: month, monthsUntilDeadline: months, type: profile.incomeType) }
        let estimate = TaxEstimate(
            year: Int(month.prefix(4)) ?? 2026,
            taxableIncomeCents: 12_000_000,
            regime: "simplified",
            taxDueCents: 1_724_434,
            withheldCents: 0,
            differenceCents: 1_724_434,
            steps: [
                TaxStep(label: "Rendimentos tributáveis no ano", amountCents: 12_000_000),
                TaxStep(label: "(−) Desconto simplificado", amountCents: 1_764_000),
                TaxStep(label: "(=) Base de cálculo", amountCents: 10_236_000),
                TaxStep(label: "Imposto pela tabela, com o redutor", amountCents: 1_724_434),
                TaxStep(label: "(−) Retido na fonte no ano", amountCents: 0),
                TaxStep(label: "(=) Diferença", amountCents: 1_724_434),
            ],
            alternative: .init(regime: "complete", taxDueCents: 1_883_461)
        )
        return TaxEstimateResponse(
            year: estimate.year,
            disclaimer: Self.disclaimer,
            tableVerifiedOfficial: true,
            estimate: estimate,
            monthlyReserveCents: (estimate.differenceCents + months - 1) / months,
            monthsUntilDeadline: months,
            incomeType: .salaried
        )
    }

    static let disclaimer = "Estimativa aproximada, feita com os dados do app. Não é cálculo oficial e não substitui a declaração à Receita Federal."

    /// Autônomo com R$ 6.000 por mês de pessoas físicas, INSS de 20% e R$ 500 de livro-caixa.
    /// Por mês: base 4.300, tabela 292,01, redução 179,75, carnê-leão 112,26.
    static func selfEmployedExample(month: String, monthsUntilDeadline months: Int, type: IncomeType) -> TaxEstimateResponse {
        let year = Int(month.prefix(4)) ?? 2026
        let current = Int(month.suffix(2)) ?? 12
        let carne = (1...max(1, current)).map { m in
            let key = String(format: "%04d-%02d", year, m)
            return CarneLeaoMonth(month: key, fromIndividualsCents: 600_000, fromCompaniesCents: 0, inssPaidCents: 120_000,
                                  inssWithheldCents: 0, bookDeductionCents: 50_000, deductionKind: "legal", deductionCents: 170_000,
                                  baseCents: 430_000, taxCents: 11_226, payableCents: 11_226, dueDate: carneLeaoDueDate(key))
        }
        let estimate = TaxEstimate(
            year: year,
            taxableIncomeCents: 7_200_000,
            regime: "complete",
            taxDueCents: 195_582,
            withheldCents: 0,
            carneLeaoPaidCents: 134_712,
            differenceCents: 60_870,
            steps: [
                TaxStep(label: "Rendimentos tributáveis no ano", amountCents: 7_200_000),
                TaxStep(label: "(−) Contribuição ao INSS", amountCents: 1_440_000),
                TaxStep(label: "(−) Dependentes (0)", amountCents: 0),
                TaxStep(label: "(−) Saúde, educação e previdência", amountCents: 0),
                TaxStep(label: "(−) Livro-caixa", amountCents: 600_000),
                TaxStep(label: "(=) Base de cálculo", amountCents: 5_160_000),
                TaxStep(label: "Imposto pela tabela, com o redutor", amountCents: 195_582),
                TaxStep(label: "(−) Retido na fonte no ano", amountCents: 0),
                TaxStep(label: "(−) Carnê-leão do ano", amountCents: 134_712),
                TaxStep(label: "(=) Diferença", amountCents: 60_870),
            ],
            alternative: .init(regime: "simplified", taxDueCents: 338_701)
        )
        return TaxEstimateResponse(
            year: year, disclaimer: disclaimer, tableVerifiedOfficial: true, estimate: estimate,
            monthlyReserveCents: (estimate.differenceCents + months - 1) / months, monthsUntilDeadline: months,
            incomeType: type,
            carneLeao: CarneLeao(darfCode: "0190", months: carne, totalSoFarCents: 11_226 * carne.count, projectedAnnualCents: 134_712)
        )
    }

    /// Último dia útil (segunda a sexta) do mês seguinte, como no backend. Feriados não entram.
    static func carneLeaoDueDate(_ month: String) -> String {
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2 else { return month }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        // Dia 0 do mês m+2 = último dia do mês m+1.
        var date = calendar.date(from: DateComponents(year: parts[0], month: parts[1] + 2, day: 0))!
        while [1, 7].contains(calendar.component(.weekday, from: date)) {
            date = calendar.date(byAdding: .day, value: -1, to: date)!
        }
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year!, c.month!, c.day!)
    }

    /// Meses do mês atual até o fim do prazo da declaração (maio do ano seguinte), contando os dois.
    static func monthsUntilDeadline(month: String, deadlineMonth: Int) -> Int {
        let parts = month.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 2 else { return 1 }
        let deadline = (parts[0] + 1) * 12 + (deadlineMonth - 1)
        let now = parts[0] * 12 + (parts[1] - 1)
        return max(1, deadline - now + 1)
    }

    func me() async throws -> Me {
        Me(id: "demo", name: "Usuário de demonstração", email: nil, connectionsCount: demoConnections.count, devicesCount: 0, hasTaxProfile: demoTaxProfile != nil)
    }

    func consents() async throws -> [ConsentRecord] {
        [
            ConsentRecord(id: "c2", type: "privacy_policy", action: "granted",
                          purpose: "Usar os dados da conta e das transações para as funções do app Nespoli Finance, conforme a política de privacidade.",
                          termsVersion: "1.0", occurredAt: Date().addingTimeInterval(-86_400), institutionName: nil),
            ConsentRecord(id: "c1", type: "bank_data_sharing", action: "granted",
                          purpose: "Ler saldos e transações das contas escolhidas para categorizar gastos, gerar alertas e estimar o IR no app Nespoli Finance.",
                          termsVersion: "1.0", occurredAt: Date().addingTimeInterval(-90_000), institutionName: "Banco de demonstração"),
        ]
    }

    /// No modo demonstração, "excluir" volta os dados de exemplo ao começo.
    func deleteAccount() async throws {
        resetDemo()
    }
}
