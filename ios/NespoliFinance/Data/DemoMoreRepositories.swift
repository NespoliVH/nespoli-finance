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
    func taxEstimate() async throws -> TaxEstimateResponse {
        guard demoTaxProfile != nil else { throw APIError.server(status: 409, code: "profile_required") }
        let months = Self.monthsUntilDeadline(month: month, deadlineMonth: 5)
        let estimate = TaxEstimate(
            year: Int(month.prefix(4)) ?? 2026,
            taxableIncomeCents: 12_000_000,
            regime: "simplified",
            taxDueCents: 1_748_780,
            withheldCents: 0,
            differenceCents: 1_748_780,
            steps: [
                TaxStep(label: "Rendimentos tributáveis no ano", amountCents: 12_000_000),
                TaxStep(label: "(−) Desconto simplificado", amountCents: 1_675_434),
                TaxStep(label: "(=) Base de cálculo", amountCents: 10_324_566),
                TaxStep(label: "Imposto pela tabela, com o redutor", amountCents: 1_748_780),
                TaxStep(label: "(−) Retido na fonte no ano", amountCents: 0),
                TaxStep(label: "(=) Diferença", amountCents: 1_748_780),
            ],
            alternative: .init(regime: "complete", taxDueCents: 1_883_451)
        )
        return TaxEstimateResponse(
            year: estimate.year,
            disclaimer: "Estimativa aproximada, feita com os dados do app. Não é cálculo oficial e não substitui a declaração à Receita Federal.",
            tableVerifiedOfficial: false,
            estimate: estimate,
            monthlyReserveCents: (estimate.differenceCents + months - 1) / months,
            monthsUntilDeadline: months
        )
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
        Me(id: "demo", name: "Usuário de demonstração", email: nil, connectionsCount: 1, devicesCount: 0, hasTaxProfile: demoTaxProfile != nil)
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
