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
                Text("Para estimar o imposto, informe o salário bruto do seu holerite. O banco só mostra o valor líquido, depois dos descontos.")
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
                    Text("No modo demonstração, a estimativa é um exemplo fixo para salário de R$ 10.000.")
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

/// Perfil fiscal: salário bruto, IR retido por mês e dependentes.
struct TaxProfileForm: View {
    let onSave: (TaxProfile) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var salary: String
    @State private var withheld: String
    @State private var dependents: Int

    init(initial: TaxProfile?, onSave: @escaping (TaxProfile) -> Void) {
        self.onSave = onSave
        _salary = State(initialValue: initial.map { TaxViewModel.editable($0.grossMonthlySalaryCents) } ?? "")
        _withheld = State(initialValue: initial?.withheldMonthlyCents.map { TaxViewModel.editable($0) } ?? "")
        _dependents = State(initialValue: initial?.dependentsCount ?? 0)
    }

    private var salaryCents: Cents? { TaxViewModel.parseReais(salary) }
    private var withheldCents: Cents?? {
        withheld.trimmingCharacters(in: .whitespaces).isEmpty ? .some(nil) : TaxViewModel.parseReais(withheld).map { .some($0) }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Salário bruto por mês (R$)", text: $salary).keyboardType(.decimalPad)
                    TextField("IR retido por mês (R$), se souber", text: $withheld).keyboardType(.decimalPad)
                    Stepper("Dependentes: \(dependents)", value: $dependents, in: 0...20)
                } footer: {
                    Text("Os dois valores estão no holerite. O IR retido aparece como \"IRRF\".")
                }
            }
            .navigationTitle("Perfil fiscal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Salvar") {
                        guard let s = salaryCents, let w = withheldCents else { return }
                        onSave(TaxProfile(grossMonthlySalaryCents: s, withheldMonthlyCents: w, dependentsCount: dependents))
                        dismiss()
                    }
                    .disabled(salaryCents == nil || withheldCents == nil)
                }
            }
        }
    }
}
