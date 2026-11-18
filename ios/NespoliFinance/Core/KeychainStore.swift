import Foundation
import Security

/// Guarda segredos (tokens de sessão) no Keychain do iOS (RNF04).
///
/// O Keychain é criptografado pelo sistema e preso ao aparelho. Nunca usar
/// UserDefaults para isso: ele grava em texto puro num arquivo do app.
struct KeychainStore {
    let service: String

    init(service: String = "br.com.nespoli.finance") {
        self.service = service
    }

    func set(_ value: String, for key: String) throws {
        let data = Data(value.utf8)
        let query = baseQuery(key)
        SecItemDelete(query as CFDictionary)
        var attrs = query
        attrs[kSecValueData as String] = data
        // Só pode ser lido com o aparelho desbloqueado e não vai para backup em outro aparelho.
        attrs[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        let status = SecItemAdd(attrs as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    func get(_ key: String) -> String? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func delete(_ key: String) {
        SecItemDelete(baseQuery(key) as CFDictionary)
    }

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

struct KeychainError: Error {
    let status: OSStatus
}
