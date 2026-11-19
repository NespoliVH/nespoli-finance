import LocalAuthentication
import SwiftUI

/// Bloqueio com Face ID ao abrir o app (RF03).
///
/// Usa a política .deviceOwnerAuthentication: tenta o Face ID e, se falhar
/// ou não existir, aceita o código do aparelho. Se o aparelho não tem nem
/// código configurado, não há como bloquear, e o app abre direto.
struct BiometricLock: ViewModifier {
    let enabled: Bool
    @AppStorage(BiometricLock.preferenceKey) private var requireBiometrics = true
    @Environment(\.scenePhase) private var scenePhase
    /// Começa bloqueado: quem abre o app já com sessão precisa se identificar.
    @State private var locked = true
    @State private var authenticating = false
    @State private var failed = false

    nonisolated static let preferenceKey = "requireBiometrics"

    nonisolated static func shouldLock(enabled: Bool, required: Bool, locked: Bool, available: Bool) -> Bool {
        enabled && required && locked && available
    }

    private var isLocked: Bool {
        Self.shouldLock(enabled: enabled, required: requireBiometrics, locked: locked, available: Self.canAuthenticate())
    }

    func body(content: Content) -> some View {
        content
            .overlay {
                if isLocked {
                    LockScreen(failed: failed) { Task { await unlock() } }
                }
            }
            .task { if isLocked { await unlock() } }
            .onChange(of: enabled) { _, nowEnabled in
                // Acabou de entrar com a Apple: não pede o Face ID logo em seguida.
                if nowEnabled { locked = false }
            }
            .onChange(of: scenePhase) { _, phase in
                switch phase {
                case .background: locked = true
                case .active: if isLocked { Task { await unlock() } }
                default: break
                }
            }
    }

    @MainActor
    private func unlock() async {
        guard !authenticating else { return }
        authenticating = true
        defer { authenticating = false }
        let context = LAContext()
        do {
            let ok = try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Desbloquear o Nespoli Finance")
            locked = !ok
            failed = !ok
        } catch {
            failed = true
        }
    }

    static func canAuthenticate() -> Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }
}

/// Cobre as telas enquanto o app está bloqueado, para os valores não aparecerem.
private struct LockScreen: View {
    let failed: Bool
    let unlock: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: "lock.fill")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("Nespoli Finance bloqueado").font(.title2.bold())
            if failed {
                Text("Não foi possível confirmar que é você.").foregroundStyle(.secondary)
            }
            Button("Desbloquear", action: unlock)
                .buttonStyle(.borderedProminent)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
    }
}

extension View {
    func biometricLock(enabled: Bool) -> some View {
        modifier(BiometricLock(enabled: enabled))
    }
}
