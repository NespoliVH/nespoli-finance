import SwiftUI

/// Bancos conectados: contas e saldos, estado de cada conexão e as ações.
struct ConnectionsView: View {
    @State var model: ConnectionsViewModel
    @State private var confirmingDisconnect: BankConnection?

    var body: some View {
        List {
            if let notice = model.notice {
                Section { Label(notice, systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
            }
            if let error = model.errorMessage {
                Section {
                    Label(error, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
                    Button("Tentar de novo") { Task { await model.load() } }
                }
            }
            if model.connections.isEmpty && !model.isLoading {
                Section {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Nenhum banco conectado").font(.headline)
                        Text("Conecte sua conta pelo Open Finance para o app ler as transações e montar o resumo. Sua senha fica só com o banco.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                    Button { model.beginConnect() } label: { Label("Conectar banco", systemImage: "plus.circle.fill") }
                }
            }
            ForEach(model.connections) { connection in
                ConnectionSection(
                    connection: connection,
                    onReconnect: { model.beginReconnect(connection) },
                    onSync: { Task { await model.sync(connection) } },
                    onDisconnect: { confirmingDisconnect = connection }
                )
            }
        }
        .navigationTitle("Bancos conectados")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { model.beginConnect() } label: { Label("Conectar banco", systemImage: "plus") }
            }
        }
        .overlay { if model.isLoading && model.connections.isEmpty { ProgressView() } }
        .refreshable { await model.load() }
        .task { await model.load() }
        .sheet(item: $model.flow) { _ in
            ConnectFlowView(model: model)
        }
        .confirmationDialog(
            "Desconectar \(confirmingDisconnect?.institutionName ?? "o banco")?",
            isPresented: Binding(get: { confirmingDisconnect != nil }, set: { if !$0 { confirmingDisconnect = nil } }),
            titleVisibility: .visible,
            presenting: confirmingDisconnect
        ) { connection in
            Button("Desconectar", role: .destructive) { Task { await model.disconnect(connection) } }
        } message: { _ in
            Text("O app para de ler esse banco e apaga as contas e transações dele. O consentimento fica registrado como revogado.")
        }
    }
}

private struct ConnectionSection: View {
    let connection: BankConnection
    let onReconnect: () -> Void
    let onSync: () -> Void
    let onDisconnect: () -> Void

    var body: some View {
        Section {
            ForEach(connection.accounts) { account in
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(account.name)
                        Text([account.typeLabel, account.numberLast4.map { "final \($0)" }].compactMap { $0 }.joined(separator: " · "))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(Money.format(account.balanceCents))
                        .monospacedDigit()
                        .foregroundStyle(account.balanceCents < 0 ? .red : .primary)
                }
                .accessibilityElement(children: .combine)
            }
            if connection.status.needsReconnect {
                Button(action: onReconnect) { Label("Reconectar", systemImage: "arrow.triangle.2.circlepath") }
            } else if connection.status != .revoked {
                Button(action: onSync) { Label("Atualizar agora", systemImage: "arrow.clockwise") }
                    .disabled(connection.status == .updating)
            }
            Button(role: .destructive, action: onDisconnect) { Label("Desconectar", systemImage: "xmark.circle") }
        } header: {
            HStack {
                Text(connection.institutionName)
                Spacer()
                StatusBadge(status: connection.status)
            }
        } footer: {
            VStack(alignment: .leading, spacing: 2) {
                Text(ConnectionsViewModel.lastSyncText(connection.lastSyncedAt))
                if let expires = connection.consentExpiresAt {
                    Text("Consentimento válido até \(expires.formatted(date: .abbreviated, time: .omitted))")
                }
                if connection.status == .revoked {
                    Text("O banco encerrou esta conexão. Desconecte e conecte de novo para voltar a ver os dados.")
                }
            }
        }
    }
}

private struct StatusBadge: View {
    let status: ConnectionStatus

    var body: some View {
        Text(status.label)
            .font(.caption2.bold())
            .textCase(nil)
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
    }

    private var color: Color {
        switch status {
        case .active: return .green
        case .updating: return .blue
        case .loginError, .consentExpired: return .orange
        case .revoked, .unknown: return .secondary
        }
    }
}

/// A folha de conectar: primeiro o consentimento, depois o Pluggy Connect.
struct ConnectFlowView: View {
    let model: ConnectionsViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var agreed = false

    var body: some View {
        NavigationStack {
            Group {
                switch model.flow?.stage {
                case .pluggy(let url):
                    PluggyConnectView(url: url) { event in Task { await model.handle(event) } }
                        .ignoresSafeArea(edges: .bottom)
                case .loading:
                    ProgressView("Abrindo a conexão segura…")
                case .consent, .none:
                    consentForm
                }
            }
            .navigationTitle(model.flow?.institutionName.map { "Reconectar \($0)" } ?? "Conectar banco")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
            }
        }
        .interactiveDismissDisabled(model.flow?.stage == .loading)
    }

    private var consentForm: some View {
        Form {
            Section("O que o app vai ler") {
                Label("Saldos e transações das contas que você escolher", systemImage: "list.bullet.rectangle")
                Label("Só leitura: o app não faz pagamentos nem transferências", systemImage: "eye")
                Label("Sua senha é digitada no ambiente do Pluggy e do banco; o app nunca a vê", systemImage: "lock.fill")
            }
            Section {
                Text(ConnectionsViewModel.purpose)
            } header: {
                Text("Finalidade")
            } footer: {
                Text("A conexão usa o Open Finance, regulado pelo Banco Central, por meio do Pluggy. Você pode desconectar quando quiser, e o aceite fica registrado (LGPD). Termos versão \(ConnectionsViewModel.termsVersion).")
            }
            if !model.usesPluggyWidget {
                Section {
                    Text("Modo demonstração: será criado um banco de exemplo, sem abrir o Pluggy.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            Section {
                Toggle("Li e concordo com o compartilhamento", isOn: $agreed)
                Button("Continuar para o banco") { Task { await model.acceptConsent() } }
                    .disabled(!agreed)
            }
        }
    }
}
