import Charts
import SwiftUI

/// Tela inicial: quanto foi gasto no mês e em quê (RF20, RF21).
struct SummaryView: View {
    @State var model: SummaryViewModel
    let isDemo: Bool

    var body: some View {
        NavigationStack {
            List {
                if isDemo {
                    Section {
                        Label("Modo demonstração: dados de exemplo, nada vem do seu banco.", systemImage: "info.circle")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                monthPicker
                content
            }
            .navigationTitle("Resumo")
            .refreshable { await model.load() }
            .task { await model.load() }
        }
    }

    private var monthPicker: some View {
        HStack {
            Button { Task { await model.goToPreviousMonth() } } label: { Image(systemName: "chevron.left") }
                .accessibilityLabel("Mês anterior")
            Spacer()
            Text(model.monthTitle.prefix(1).uppercased() + model.monthTitle.dropFirst()).font(.headline)
            Spacer()
            Button { Task { await model.goToNextMonth() } } label: { Image(systemName: "chevron.right") }
                .disabled(!model.canGoForward)
                .accessibilityLabel("Próximo mês")
        }
        .buttonStyle(.borderless)
    }

    @ViewBuilder private var content: some View {
        switch model.state {
        case .loading:
            HStack { Spacer(); ProgressView(); Spacer() }
        case .failed(let message):
            Section {
                Text(message)
                Button("Tentar de novo") { Task { await model.load() } }
            }
        case .loaded(let summary):
            Section {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Gasto no mês").font(.subheadline).foregroundStyle(.secondary)
                    Text(Money.format(summary.totalCents)).font(.largeTitle.bold()).monospacedDigit()
                }
                .accessibilityElement(children: .combine)
                if !model.chartSlices.isEmpty {
                    Chart(model.chartSlices) { slice in
                        SectorMark(angle: .value("Valor", slice.totalCents), innerRadius: .ratio(0.6), angularInset: 1.5)
                            .foregroundStyle(slice.id.color)
                            .accessibilityLabel(slice.name)
                            .accessibilityValue("\(Money.format(slice.totalCents)), \(Money.percent(basisPoints: slice.percentBasisPoints))")
                    }
                    .frame(height: 200)
                }
                if summary.connections.importing {
                    Label("Importando suas transações. Isso pode levar alguns minutos.", systemImage: "arrow.triangle.2.circlepath")
                        .font(.footnote)
                }
                if let synced = summary.connections.oldestSyncAt {
                    Text("Atualizado \(synced, format: .relative(presentation: .named))")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section("Por categoria") {
                ForEach(summary.categories) { c in
                    NavigationLink {
                        TransactionsView(model: TransactionsViewModel(repository: model.repositoryForChildren, month: model.month, category: c.id))
                    } label: {
                        CategoryRow(category: c)
                    }
                }
            }
        }
    }
}

struct CategoryRow: View {
    let category: CategoryTotal

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: category.id.icon)
                .foregroundStyle(category.id.color)
                .frame(width: 28)
            VStack(alignment: .leading) {
                Text(category.name)
                Text("\(category.count) \(category.count == 1 ? "compra" : "compras")")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing) {
                Text(Money.format(category.totalCents)).monospacedDigit()
                Text(Money.percent(basisPoints: category.percentBasisPoints))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}
