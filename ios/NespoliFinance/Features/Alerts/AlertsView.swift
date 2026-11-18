import SwiftUI

struct AlertsView: View {
    @State var model: AlertsViewModel

    var body: some View {
        NavigationStack {
            List {
                if let error = model.errorMessage {
                    Section {
                        Text(error)
                        Button("Tentar de novo") { Task { await model.load() } }
                    }
                }
                if model.loaded && model.alerts.isEmpty && model.errorMessage == nil {
                    ContentUnavailableView(
                        "Nenhum alerta",
                        systemImage: "bell.slash",
                        description: Text("Quando o gasto de uma categoria passar bastante da sua média, o aviso aparece aqui.")
                    )
                }
                ForEach(model.alerts) { alert in
                    AlertRow(alert: alert)
                        .contentShape(Rectangle())
                        .onTapGesture { Task { await model.open(alert) } }
                }
            }
            .navigationTitle("Alertas")
            .toolbar {
                if model.unreadCount > 0 {
                    Button("Marcar todos como lidos") { Task { await model.markAllRead() } }
                }
            }
            .refreshable { await model.load() }
            .task { await model.load() }
        }
    }
}

struct AlertRow: View {
    let alert: SpendingAlert

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: alert.category.id.icon)
                .foregroundStyle(alert.category.id.color)
                .frame(width: 28)
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(alert.category.name).font(.headline)
                    Spacer()
                    Text(SummaryViewModel.title(alert.month)).font(.caption).foregroundStyle(.secondary)
                }
                Text(AlertsViewModel.sentence(alert)).font(.subheadline)
            }
            if !alert.read {
                Circle().fill(.blue).frame(width: 10, height: 10).padding(.top, 6)
                    .accessibilityLabel("não lido")
            }
        }
        .accessibilityElement(children: .combine)
    }
}
