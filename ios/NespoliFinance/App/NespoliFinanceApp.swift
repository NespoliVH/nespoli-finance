import SwiftUI

@main
struct NespoliFinanceApp: App {
    private let environment = AppEnvironment.make()

    var body: some Scene {
        WindowGroup {
            RootView(environment: environment)
        }
    }
}

/// As cinco abas do app (etapa 4).
struct RootView: View {
    let environment: AppEnvironment

    var body: some View {
        TabView {
            SummaryView(model: SummaryViewModel(repository: environment.repository), isDemo: environment.isDemo)
                .tabItem { Label("Resumo", systemImage: "chart.pie.fill") }
            NavigationStack {
                TransactionsView(model: TransactionsViewModel(repository: environment.repository, month: DemoFinanceRepository.currentMonth()))
            }
            .tabItem { Label("Transações", systemImage: "list.bullet") }
            AlertsView(model: AlertsViewModel(repository: environment.repository))
                .tabItem { Label("Alertas", systemImage: "bell.fill") }
            TaxView(model: TaxViewModel(repository: environment.repository, isDemo: environment.isDemo))
                .tabItem { Label("IR", systemImage: "doc.text.fill") }
            SettingsView(model: SettingsViewModel(repository: environment.repository, isDemo: environment.isDemo),
                         connections: ConnectionsViewModel(repository: environment.repository))
                .tabItem { Label("Ajustes", systemImage: "gearshape.fill") }
        }
    }
}
