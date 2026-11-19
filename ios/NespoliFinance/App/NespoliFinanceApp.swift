import SwiftUI

@main
struct NespoliFinanceApp: App {
    @State private var session = SessionModel()

    var body: some Scene {
        WindowGroup {
            AppRootView(session: session)
        }
    }
}

/// Mostra a tela de entrada ou as abas, conforme o estado da sessão.
struct AppRootView: View {
    let session: SessionModel

    var body: some View {
        Group {
            if let environment = session.environment {
                MainTabsView(environment: environment, session: session)
                    // Ambiente novo = ViewModels novos, sem dados da sessão anterior.
                    .id(session.generation)
            } else {
                SignInView(session: session)
            }
        }
        // Face ID ao abrir (RF03). Só com sessão real: no modo demonstração não há dado a proteger.
        .biometricLock(enabled: session.state == .signedIn)
    }
}

/// As cinco abas do app (etapa 4).
struct MainTabsView: View {
    let environment: AppEnvironment
    let session: SessionModel

    var body: some View {
        TabView {
            SummaryView(model: SummaryViewModel(repository: environment.repository), isDemo: environment.isDemo)
                .tabItem { Label("Resumo", systemImage: "chart.pie.fill") }
            NavigationStack {
                TransactionsView(model: TransactionsViewModel(repository: environment.repository, month: DemoFinanceRepository.currentMonth(),
                                                           taxRepository: environment.repository))
            }
            .tabItem { Label("Transações", systemImage: "list.bullet") }
            AlertsView(model: AlertsViewModel(repository: environment.repository))
                .tabItem { Label("Alertas", systemImage: "bell.fill") }
            TaxView(model: TaxViewModel(repository: environment.repository, isDemo: environment.isDemo))
                .tabItem { Label("IR", systemImage: "doc.text.fill") }
            SettingsView(model: SettingsViewModel(repository: environment.repository, isDemo: environment.isDemo),
                         connections: ConnectionsViewModel(repository: environment.repository),
                         onSignOut: { Task { await session.signOut() } },
                         onAccountDeleted: { session.accountDeleted() })
                .tabItem { Label("Ajustes", systemImage: "gearshape.fill") }
        }
    }
}
