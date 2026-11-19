import Foundation

/// O que um cofre de segredos precisa saber fazer. O app usa o Keychain; os
/// testes usam um cofre em memória, porque o Keychain do simulador não
/// funciona sem assinatura de código.
protocol SecretStore {
    func set(_ value: String, for key: String) throws
    func get(_ key: String) -> String?
    func delete(_ key: String)
}

extension KeychainStore: SecretStore {}

/// Os dois tokens que o backend devolve no login (módulo 3).
struct SessionTokens: Codable, Equatable {
    let accessToken: String
    let refreshToken: String
    /// Validade do token de acesso, em segundos (15 minutos no backend).
    let expiresIn: Int
}

/// Guarda a sessão no Keychain (RNF04): nada de token em UserDefaults ou em arquivo.
///
/// O token de acesso dura pouco (15 min) e vai em toda chamada. O de renovação
/// dura 60 dias e só serve para pedir um novo par. Se um vazar, o estrago é
/// limitado: o de acesso expira logo, e o de renovação é trocado a cada uso.
final class SessionStore: @unchecked Sendable {
    static let accessKey = "access_token"
    static let refreshKey = "refresh_token"

    private let store: SecretStore
    private let lock = NSLock()

    init(store: SecretStore = KeychainStore()) {
        self.store = store
    }

    var accessToken: String? { locked { store.get(Self.accessKey) } }
    var refreshToken: String? { locked { store.get(Self.refreshKey) } }
    /// Existe sessão enquanto houver token de renovação, mesmo com o de acesso vencido.
    var hasSession: Bool { refreshToken != nil }

    func save(_ tokens: SessionTokens) throws {
        try locked {
            try store.set(tokens.accessToken, for: Self.accessKey)
            try store.set(tokens.refreshToken, for: Self.refreshKey)
        }
    }

    func clear() {
        locked {
            store.delete(Self.accessKey)
            store.delete(Self.refreshKey)
        }
    }

    private func locked<T>(_ body: () throws -> T) rethrows -> T {
        lock.lock(); defer { lock.unlock() }
        return try body()
    }
}
