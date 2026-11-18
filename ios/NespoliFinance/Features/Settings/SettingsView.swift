import SwiftUI

/// Ajustes. Nesta primeira parte, só o essencial; consentimentos, exclusão da
/// conta e notificações chegam junto com o login.
struct SettingsView: View {
    let isDemo: Bool

    var body: some View {
        NavigationStack {
            List {
                Section("Conta") {
                    LabeledContent("Modo", value: isDemo ? "Demonstração" : "Conectado")
                }
                Section {
                    Text("Os valores mostrados no modo demonstração são de exemplo. Nenhum dado bancário real é usado.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Sobre") {
                    LabeledContent("Versão", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "-")
                }
            }
            .navigationTitle("Ajustes")
        }
    }
}
