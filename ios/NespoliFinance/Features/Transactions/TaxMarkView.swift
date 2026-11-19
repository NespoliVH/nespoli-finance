import SwiftUI

/// Marcações do Imposto de Renda numa transação (RF25, RF26 e livro-caixa).
///
/// Entrada: é rendimento tributável? Se for de trabalho autônomo, veio de uma
/// pessoa física (entra no carnê-leão) ou de uma empresa (que já retém o imposto)?
/// Gasto: é despesa dedutível (saúde, educação, previdência) ou do trabalho
/// autônomo (livro-caixa)?
struct TaxMarkView: View {
    let transaction: Transaction
    let onSave: (TaxMark) -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var isIncome: Bool
    @State private var source: String
    @State private var deductible: String

    static let deductibleOptions: [(value: String, label: String)] = [
        ("", "Não é dedutível"),
        ("health", "Saúde"),
        ("education", "Educação"),
        ("pension", "Previdência privada"),
        ("business", "Despesa do trabalho autônomo (livro-caixa)"),
    ]

    init(transaction: Transaction, onSave: @escaping (TaxMark) -> Void) {
        self.transaction = transaction
        self.onSave = onSave
        _isIncome = State(initialValue: transaction.isConfirmedIncome)
        _source = State(initialValue: transaction.incomeSource ?? "individual")
        _deductible = State(initialValue: transaction.deductibleType ?? "")
    }

    /// O pedido ao backend a partir do que está na tela.
    nonisolated static func mark(for tx: Transaction, isIncome: Bool, source: String, deductible: String) -> TaxMark {
        if tx.direction == .credit {
            return TaxMark(taxableIncome: isIncome ? "confirmed" : "no", incomeSource: .some(isIncome ? source : nil), deductibleType: nil)
        }
        return TaxMark(taxableIncome: nil, incomeSource: nil, deductibleType: .some(deductible.isEmpty ? nil : deductible))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent(transaction.description, value: Money.format(transaction.amountCents))
                }
                if transaction.direction == .credit {
                    Section {
                        Toggle("É rendimento tributável", isOn: $isIncome)
                    } footer: {
                        Text("Presente, reembolso e transferência entre suas contas não são rendimento. Salário já entra pelo perfil fiscal.")
                    }
                    if isIncome {
                        Section {
                            Picker("Quem pagou", selection: $source) {
                                Text("Pessoa física").tag("individual")
                                Text("Empresa").tag("company")
                            }
                            .pickerStyle(.segmented)
                        } header: {
                            Text("Quem pagou")
                        } footer: {
                            Text("Para autônomos: o que vem de pessoa física entra no carnê-leão do mês. Empresa já retém o imposto.")
                        }
                    }
                } else {
                    Section("Despesa dedutível") {
                        Picker("Tipo", selection: $deductible) {
                            ForEach(Self.deductibleOptions, id: \.value) { Text($0.label).tag($0.value) }
                        }
                        .pickerStyle(.inline)
                        .labelsHidden()
                    }
                }
            }
            .navigationTitle("Imposto de Renda")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Salvar") {
                        onSave(Self.mark(for: transaction, isIncome: isIncome, source: source, deductible: deductible))
                        dismiss()
                    }
                }
            }
        }
    }
}
