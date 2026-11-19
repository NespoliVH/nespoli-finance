import SwiftUI

/// Transações do mês, da mais recente para a mais antiga (RF22).
struct TransactionsView: View {
    @State var model: TransactionsViewModel
    @State private var editing: Transaction?
    @State private var markingTax: Transaction?

    var body: some View {
        List {
            Section {
                Picker("Tipo", selection: $model.kind) {
                    ForEach(TransactionKind.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.segmented)
                .disabled(model.category != nil)
            }
            if let notice = model.notice {
                Section {
                    Label(notice, systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .onTapGesture { model.dismissNotice() }
                }
            }
            if let error = model.errorMessage {
                Section {
                    Text(error)
                    Button("Tentar de novo") { Task { await model.reload() } }
                }
            }
            Section {
                if model.items.isEmpty && !model.isLoading {
                    Text("Nenhuma transação neste mês.").foregroundStyle(.secondary)
                }
                ForEach(model.items) { tx in
                    Button {
                        if tx.isSpending { editing = tx } else if tx.direction == .credit && model.canMarkTax { markingTax = tx }
                    } label: { TransactionRow(tx: tx) }
                        .buttonStyle(.plain)
                        .accessibilityHint(tx.isSpending ? "Toque para trocar a categoria" : (tx.direction == .credit && model.canMarkTax ? "Toque para marcar como rendimento" : ""))
                        .swipeActions(edge: .trailing) {
                            if model.canMarkTax && (tx.isSpending || tx.direction == .credit) {
                                Button("IR") { markingTax = tx }.tint(.indigo)
                            }
                        }
                }
                if model.canLoadMore {
                    ProgressView().frame(maxWidth: .infinity).task { await model.loadMore() }
                }
            }
        }
        .navigationTitle(model.category?.name ?? "Transações")
        .refreshable { await model.reload() }
        .task { await model.reload() }
        .onChange(of: model.kind) { Task { await model.reload() } }
        .sheet(item: $markingTax) { tx in
            TaxMarkView(transaction: tx) { mark in
                Task { await model.markTax(tx, mark) }
            }
        }
        .sheet(item: $editing) { tx in
            CategoryCorrectionView(transaction: tx) { category, future, past in
                Task { await model.correct(tx, to: category, applyToFuture: future, includePast: past) }
            }
        }
    }
}

struct TransactionRow: View {
    let tx: Transaction

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: tx.categoryId?.icon ?? (tx.direction == .credit ? "arrow.down.circle.fill" : "arrow.left.arrow.right"))
                .foregroundStyle(tx.categoryId?.color ?? (tx.direction == .credit ? .green : .secondary))
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(tx.description).lineLimit(1)
                HStack(spacing: 4) {
                    Text(TransactionsViewModel.shortDate(tx.date))
                    Text("·")
                    Text(tx.categoryId?.name ?? (tx.direction == .credit ? "Entrada" : "Não é gasto"))
                    if tx.isManual { Image(systemName: "pencil").accessibilityLabel("corrigida por você") }
                    if tx.isConfirmedIncome || tx.deductibleType != nil {
                        Image(systemName: "doc.text").accessibilityLabel("marcada para o Imposto de Renda")
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Text((tx.direction == .credit ? "+ " : "") + Money.format(tx.amountCents))
                .monospacedDigit()
                .foregroundStyle(tx.direction == .credit ? .green : .primary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
