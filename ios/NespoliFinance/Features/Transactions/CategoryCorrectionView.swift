import SwiftUI

/// Correção da categoria (RF16 a RF18), em uma folha que sobe da parte de baixo.
///
/// "Aplicar a outras compras deste lugar" vem desligado: a correção pontual é
/// o padrão (etapa 4). Ligado, aparece a segunda opção, "incluir as compras
/// antigas", que vem ligada porque foi o pedido ao testar (18/11/2026).
struct CategoryCorrectionView: View {
    let transaction: Transaction
    let onSave: (CategoryID, Bool, Bool) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var selected: CategoryID
    @State private var applyToFuture = false
    @State private var includePast = true

    init(transaction: Transaction, onSave: @escaping (CategoryID, Bool, Bool) -> Void) {
        self.transaction = transaction
        self.onSave = onSave
        _selected = State(initialValue: transaction.categoryId ?? .outros)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    LabeledContent(transaction.description, value: Money.format(transaction.amountCents))
                }
                Section("Categoria") {
                    ForEach(CategoryID.allCases) { cat in
                        Button {
                            selected = cat
                        } label: {
                            HStack {
                                Label(cat.name, systemImage: cat.icon).foregroundStyle(cat.color)
                                Spacer()
                                if cat == selected { Image(systemName: "checkmark").foregroundStyle(.tint) }
                            }
                        }
                        .accessibilityAddTraits(cat == selected ? .isSelected : [])
                    }
                }
                Section {
                    Toggle("Aplicar a outras compras deste lugar", isOn: $applyToFuture)
                    if applyToFuture {
                        Toggle("Incluir as compras antigas", isOn: $includePast)
                    }
                } footer: {
                    Text(footer)
                }
            }
            .navigationTitle("Trocar categoria")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Salvar") {
                        onSave(selected, applyToFuture, includePast)
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private var footer: String {
        if !applyToFuture { return "Só esta compra muda." }
        return includePast
            ? "Esta compra, as antigas e as próximas deste lugar vão para \(selected.name). As que você já corrigiu uma a uma ficam como estão."
            : "Esta compra e as próximas deste lugar vão para \(selected.name). As antigas ficam como estão."
    }
}
