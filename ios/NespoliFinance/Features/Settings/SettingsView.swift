import SwiftUI

/// Ajustes: bancos, conta, notificações, consentimentos e exclusão da conta.
struct SettingsView: View {
    @State var model: SettingsViewModel
    let connections: ConnectionsViewModel
    /// Preferência do aparelho, não é segredo: pode ficar no UserDefaults.
    /// Vai para o backend junto com o token de notificação, quando houver push.
    @AppStorage("showAmountsInPush") private var showAmountsInPush = false
    @State private var confirmingDelete = false

    var body: some View {
        NavigationStack {
            List {
                if model.isDemo {
                    Section {
                        Text("Modo demonstração: os dados são de exemplo, e nenhum dado bancário real é usado.")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                }
                if let error = model.errorMessage {
                    Section { Text(error) }
                }
                if model.deleted {
                    Section {
                        Label("Conta excluída. Seus dados foram apagados do app e do serviço do banco.", systemImage: "checkmark.circle.fill")
                    }
                }
                Section {
                    NavigationLink {
                        ConnectionsView(model: connections)
                    } label: {
                        Label("Bancos conectados", systemImage: "building.columns.fill")
                    }
                } header: {
                    Text("Bancos")
                } footer: {
                    Text("Conecte, atualize ou desconecte suas contas pelo Open Finance.")
                }
                if let me = model.me {
                    Section("Conta") {
                        LabeledContent("Nome", value: me.name ?? "-")
                        if let email = me.email { LabeledContent("E-mail", value: email) }
                        LabeledContent("Bancos conectados", value: "\(me.connectionsCount)")
                    }
                }
                Section {
                    Toggle("Mostrar valores nas notificações", isOn: $showAmountsInPush)
                } header: {
                    Text("Notificações")
                } footer: {
                    Text("A notificação aparece na tela bloqueada, onde outras pessoas podem ler. Desligado, ela só diz a categoria.")
                }
                Section("Privacidade") {
                    NavigationLink("Consentimentos") { ConsentsView(consents: model.consents) }
                    NavigationLink("Política de privacidade") { PrivacyPolicyView() }
                }
                Section {
                    Button("Excluir minha conta", role: .destructive) { confirmingDelete = true }
                        .disabled(model.isDeleting)
                } footer: {
                    Text("Apaga suas conexões no serviço do banco e todos os seus dados no app. Não dá para desfazer.")
                }
                Section("Sobre") {
                    LabeledContent("Versão", value: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "-")
                }
            }
            .navigationTitle("Ajustes")
            .task { await model.load() }
            .sheet(isPresented: $confirmingDelete) {
                DeleteAccountView { typed in
                    Task { await model.deleteAccount(typed: typed) }
                }
            }
        }
    }
}

/// Confirmação da exclusão: o usuário digita a palavra, para não excluir sem querer.
struct DeleteAccountView: View {
    let onConfirm: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var typed = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("Isso apaga suas conexões bancárias, transações, regras, alertas e perfil fiscal. Fica guardado só o registro de que você deu e revogou o consentimento, sem seus dados, como a LGPD exige.")
                }
                Section {
                    TextField("Digite \(SettingsViewModel.confirmationWord) para confirmar", text: $typed)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                }
            }
            .navigationTitle("Excluir conta")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .destructiveAction) {
                    Button("Excluir", role: .destructive) {
                        onConfirm(typed)
                        dismiss()
                    }
                    .disabled(!SettingsViewModel.canDelete(typed: typed))
                }
            }
        }
    }
}

struct ConsentsView: View {
    let consents: [ConsentRecord]

    var body: some View {
        List {
            if consents.isEmpty {
                Text("Nenhum consentimento registrado.").foregroundStyle(.secondary)
            }
            ForEach(consents) { c in
                VStack(alignment: .leading, spacing: 4) {
                    HStack {
                        Text(c.title).font(.headline)
                        Spacer()
                        Text(c.actionLabel)
                            .font(.caption.bold())
                            .foregroundStyle(c.action == "granted" ? .green : .secondary)
                    }
                    Text(c.purpose).font(.subheadline)
                    Text("\(c.occurredAt.formatted(date: .abbreviated, time: .shortened)) · termos \(c.termsVersion)")
                        .font(.caption).foregroundStyle(.secondary)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .navigationTitle("Consentimentos")
    }
}

/// Texto provisório. A versão final da política entra antes da publicação (RNF13).
struct PrivacyPolicyView: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("Política de privacidade").font(.title2.bold())
                Text("Versão provisória, para o protótipo do TCC.").foregroundStyle(.secondary)
                Text("O Nespoli Finance lê os saldos e as transações das contas que você escolher, por meio do Pluggy, para categorizar seus gastos, gerar alertas e estimar o Imposto de Renda. O app nunca vê a senha do seu banco.")
                Text("Os dados ficam criptografados no nosso servidor e só são usados para essas funções. Você pode ver os consentimentos que deu, desconectar um banco ou excluir a conta a qualquer momento, nos Ajustes.")
                Text("Ao excluir a conta, apagamos seus dados e as conexões no Pluggy. Guardamos apenas o registro de que o consentimento foi dado e revogado, sem seus dados, como exige a LGPD.")
            }
            .padding()
        }
        .navigationTitle("Privacidade")
        .navigationBarTitleDisplayMode(.inline)
    }
}
