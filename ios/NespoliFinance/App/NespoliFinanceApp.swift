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

/// As abas do app. Alertas e IR entram nas próximas partes.
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
            SettingsView(isDemo: environment.isDemo)
                .tabItem { Label("Ajustes", systemImage: "gearshape.fill") }
        }
    }
}
