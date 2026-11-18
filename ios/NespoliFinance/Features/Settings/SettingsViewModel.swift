import Foundation
import Observation

/// Ajustes: conta, consentimentos (RF04) e exclusão da conta (RF05).
@MainActor
@Observable
final class SettingsViewModel {
    private(set) var me: Me?
    private(set) var consents: [ConsentRecord] = []
    private(set) var errorMessage: String?
    private(set) var isDeleting = false
    private(set) var deleted = false
    let isDemo: Bool
    private let repository: AccountRepository

    /// A palavra que o usuário digita para confirmar a exclusão.
    nonisolated static let confirmationWord = "EXCLUIR"

    init(repository: AccountRepository, isDemo: Bool) {
        self.repository = repository
        self.isDemo = isDemo
    }

    func load() async {
        do {
            async let me = repository.me()
            async let consents = repository.consents()
            self.me = try await me
            self.consents = try await consents
            errorMessage = nil
        } catch let error as APIError {
            errorMessage = error.message
        } catch {
            errorMessage = APIError.invalidResponse.message
        }
    }

    nonisolated static func canDelete(typed: String) -> Bool {
        typed.trimmingCharacters(in: .whitespaces).uppercased() == confirmationWord
    }

    /// Só chama o backend com a palavra certa. Se o Pluggy falhar, o backend
    /// não apaga nada e a mensagem pede para tentar de novo.
    func deleteAccount(typed: String) async {
        guard Self.canDelete(typed: typed) else { return }
        isDeleting = true
        defer { isDeleting = false }
        do {
            try await repository.deleteAccount()
            deleted = true
            me = nil
            consents = []
        } catch let error as APIError {
            errorMessage = error.message
        } catch {
            errorMessage = APIError.invalidResponse.message
        }
    }
}
