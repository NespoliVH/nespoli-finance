import SwiftUI

/// Estimativa de IR do ano (RF27), sempre com o aviso de que não é oficial.
struct TaxView: View {
    @State var model: TaxViewModel
    @State private var editingProfile = false

    var body: some View {
        NavigationStack {
            List { content }
                .navigationTitle("Imposto de Renda")
                .toolbar {
                    if model.profile != nil {
                        Button("Editar perfil") { editingProfile = true }
                    }
                }
                .refreshable { await model.load() }
                .task { await model.load() }
                .sheet(isPresented: $editingProfile) {
                    TaxProfileForm(initial: model.profile) { profile in
                        Task { await model.save(profile) }
                    }
                }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .loading:
            HStack { Spacer(); ProgressView(); Spacer() }
        case .needsProfile:
            Section {
                Text("Para estimar o imposto, conte como você recebe: salário, trabalho autônomo ou os dois. Para o salário, vale o bruto do holerite, porque o banco só mostra o líquido.")
                Button("Preencher perfil fiscal") { editingProfile = true }
            }
        case .failed(let message):
            Section {
                Text(message)
                Button("Tentar de novo") { Task { await model.load() } }
            }
        case .loaded(let r):
            Section {
                Label(r.disclaimer, systemImage: "exclamationmark.circle")
                    .font(.footnote)
                if !r.tableVerifiedOfficial {
                    Text("As tabelas de \(String(r.year)) ainda não foram conferidas na publicação oficial da Receita Federal.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if model.isDemo {
                    Text(r.carneLeao == nil
                         ? "No modo demonstração, a estimativa é um exemplo fixo para salário de R$ 10.000."
                         : "No modo demonstração, a estimativa é um exemplo fixo de autônomo que recebe R$ 6.000 por mês de pessoas físicas.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(TaxViewModel.headline(r.estimate)).font(.headline)
                    if r.monthlyReserveCents > 0 {
                        Text("Guardando \(Money.format(r.monthlyReserveCents)) por mês, em \(r.monthsUntilDeadline) \(r.monthsUntilDeadline == 1 ? "mês" : "meses") você chega lá até o fim do prazo.")
                            .font(.subheadline)
                    }
                }
                .padding(.vertical, 4)
                LabeledContent("Declaração", value: r.estimate.regimeName)
                LabeledContent("Na outra declaração", value: Money.format(r.estimate.alternative.taxDueCents))
            }
            if let carne = r.carneLeao {
                CarneLeaoSection(carneLeao: carne)
            }
            Section("Passo a passo") {
                ForEach(r.estimate.steps) { step in
                    LabeledContent(step.label) {
                        Text(Money.format(step.amountCents)).monospacedDigit()
                    }
                    .fontWeight(step.label.hasPrefix("(=)") ? .semibold : .regular)
                }
            }
        }
    }
}

/// Carnê-leão mês a mês: o imposto do autônomo sobre o que recebeu de pessoas físicas.
struct CarneLeaoSection: View {
    let carneLeao: CarneLeao
    private let today = TaxViewModel.todayString()

    var body: some View {
        Section {
            if let next = TaxViewModel.nextCarneLeao(carneLeao, today: today), let due = next.dueDate {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Próximo DARF: \(Money.format(next.payableCents))").font(.headline)
                    Text("Referente a \(TaxViewModel.monthName(next.month)), vence em \(TaxViewModel.shortDay(due)).")
                        .font(.subheadline)
                }
                .padding(.vertical, 4)
            }
            let active = carneLeao.months.filter(\.hasActivity)
            if active.isEmpty {
                Text("Nenhum rendimento de autônomo confirmado neste ano. Marque as entradas em Transações.")
                    .foregroundStyle(.secondary)
            }
            ForEach(active.reversed()) { m in
                DisclosureGroup {
                    LabeledContent("De pessoas físicas", value: Money.format(m.fromIndividualsCents))
                    if m.fromCompaniesCents > 0 {
                        LabeledContent("De empresas (já retido)", value: Money.format(m.fromCompaniesCents))
                    }
                    LabeledContent(m.deductionKind == "legal" ? "(−) INSS, dependentes e livro-caixa" : "(−) Desconto simplificado",
                                   value: Money.format(m.deductionCents))
                    LabeledContent("(=) Base", value: Money.format(m.baseCents))
                    LabeledContent("Imposto do mês", value: Money.format(m.taxCents))
                    if m.inssPaidCents > 0 {
                        LabeledContent("INSS a pagar (GPS, até dia 15)", value: Money.format(m.inssPaidCents))
                    }
                } label: {
                    LabeledContent(TaxViewModel.monthName(m.month).capitalized) {
                        VStack(alignment: .trailing) {
                            Text(Money.format(m.payableCents)).monospacedDigit()
                            if let due = m.dueDate {
                                Text("vence \(TaxViewModel.shortDay(due))").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        } header: {
            Text("Carnê-leão")
        } footer: {
            Text("Imposto mensal sobre o que você recebe de pessoas físicas. Paga-se pelo Carnê-Leão Web, com DARF código \(carneLeao.darfCode), até o último dia útil do mês seguinte. O que vem de empresas não entra: a empresa já retém o imposto. Abaixo de R$ 10, o valor passa para o mês seguinte.")
        }
    }
}

/// Perfil fiscal: como a pessoa recebe, salário bruto, IR retido, dependentes e INSS de autônomo.
struct TaxProfileForm: View {
    let onSave: (TaxProfile) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var incomeType: IncomeType
    @State private var inssPlan: InssPlan
    @State private var salary: String
    @State private var withheld: String
    @State private var dependents: Int

    init(initial: TaxProfile?, onSave: @escaping (TaxProfile) -> Void) {
        self.onSave = onSave
        _incomeType = State(initialValue: initial?.incomeType ?? .salaried)
        _inssPlan = State(initialValue: initial?.inssPlan ?? .standard)
        _salary = State(initialValue: initial.map { TaxViewModel.editable($0.grossMonthlySalaryCents) } ?? "")
        _withheld = State(initialValue: initial?.withheldMonthlyCents.map { TaxViewModel.editable($0) } ?? "")
        _dependents = State(initialValue: initial?.dependentsCount ?? 0)
    }

    /// Autônomo sem salário: o campo some e vale zero.
    private var salaryCents: Cents? { incomeType.hasSalary ? TaxViewModel.parseReais(salary) : 0 }
    private var withheldCents: Cents?? {
        if !incomeType.hasSalary { return .some(nil) }
        return withheld.trimmingCharacters(in: .whitespaces).isEmpty ? .some(nil) : TaxViewModel.parseReais(withheld).map { .some($0) }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("Como você recebe", selection: $incomeType) {
                        ForEach(IncomeType.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Como você recebe")
                } footer: {
                    Text("Autônomo é quem trabalha por conta própria, sem carteira assinada. Quem recebe de pessoas físicas paga o carnê-leão todo mês.")
                }
                if incomeType.hasSalary {
                    Section {
                        TextField("Salário bruto por mês (R$)", text: $salary).keyboardType(.decimalPad)
                        TextField("IR retido por mês (R$), se souber", text: $withheld).keyboardType(.decimalPad)
                    } header: {
                        Text("Salário")
                    } footer: {
                        Text("Os dois valores estão no holerite. O IR retido aparece como \"IRRF\".")
                    }
                }
                if incomeType.hasSelfEmployment {
                    Section {
                        Picker("INSS de autônomo", selection: $inssPlan) {
                            ForEach(InssPlan.allCases) { Text($0.label).tag($0) }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    } header: {
                        Text("INSS de autônomo")
                    } footer: {
                        Text("O INSS pago entra como dedução no carnê-leão e na declaração. Quando uma empresa paga você, ela mesma retém 11%.")
                    }
                }
                Section {
                    Stepper("Dependentes: \(dependents)", value: $dependents, in: 0...20)
                }
            }
            .navigationTitle("Perfil fiscal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Salvar") {
                        guard let s = salaryCents, let w = withheldCents else { return }
                        onSave(TaxProfile(grossMonthlySalaryCents: s, withheldMonthlyCents: incomeType.hasSalary ? w : nil,
                                          dependentsCount: dependents, incomeType: incomeType, inssPlan: inssPlan))
                        dismiss()
                    }
                    .disabled(salaryCents == nil || withheldCents == nil)
                }
            }
        }
    }
}
