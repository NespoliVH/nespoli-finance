import AuthenticationServices
import SwiftUI

/// Tela de entrada (RF01): "Iniciar sessão com a Apple" ou modo demonstração.
///
/// O botão é o oficial da Apple (SignInWithAppleButton). As diretrizes da
/// App Store exigem esse visual, e ele já vem traduzido e acessível.
struct SignInView: View {
    let session: SessionModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            VStack(spacing: 12) {
                Image(systemName: "chart.pie.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
                Text("Nespoli Finance")
                    .font(.largeTitle.bold())
                Text("Seus gastos organizados por categoria, com alertas quando algo sair do normal e uma estimativa do Imposto de Renda.")
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            Spacer()

            if let notice = session.notice {
                Label(notice, systemImage: "info.circle")
                    .font(.footnote)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let error = session.errorMessage {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            VStack(spacing: 12) {
                SignInWithAppleButton(.signIn) { request in
                    // Nome e e-mail só são pedidos para mostrar nos Ajustes.
                    // A pessoa pode esconder o e-mail; o app funciona igual.
                    request.requestedScopes = [.fullName, .email]
                    request.nonce = session.prepareAppleRequest()
                } onCompletion: { result in
                    handle(result)
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .frame(height: 50)
                .disabled(session.isSigningIn)
                .overlay { if session.isSigningIn { ProgressView() } }

                Button("Ver demonstração") { session.startDemo() }
                    .frame(maxWidth: .infinity, minHeight: 44)
            }

            Text("A conexão com o banco só acontece depois, nos Ajustes, e sempre com o seu consentimento.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(24)
    }

    private func handle(_ result: Result<ASAuthorization, Error>) {
        switch result {
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential else {
                session.appleFailed(canceled: false)
                return
            }
            Task {
                await session.completeApple(identityToken: credential.identityToken,
                                            givenName: credential.fullName?.givenName,
                                            familyName: credential.fullName?.familyName)
            }
        case .failure(let error):
            session.appleFailed(canceled: (error as? ASAuthorizationError)?.code == .canceled)
        }
    }
}
