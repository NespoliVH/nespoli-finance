import CryptoKit
import Foundation
import Security

/// Nonce do login com a Apple: um valor aleatório usado uma vez só.
///
/// O app sorteia o valor, guarda consigo e manda à Apple apenas o hash
/// SHA-256 dele. A Apple coloca esse hash dentro do token assinado. Depois o
/// app manda ao backend o token e o valor original; o backend calcula o hash
/// e confere com o que está no token. Assim, um token roubado não serve:
/// quem o roubou não tem o valor original que gerou aquele hash.
enum Nonce {
    private static let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-._")

    /// Valor aleatório com gerador criptográfico do sistema.
    static func random(length: Int = 32) -> String {
        var result = ""
        result.reserveCapacity(length)
        while result.count < length {
            var byte: UInt8 = 0
            let status = SecRandomCopyBytes(kSecRandomDefault, 1, &byte)
            precondition(status == errSecSuccess, "Falha no gerador aleatório do sistema")
            // Descarta bytes que deixariam alguns caracteres mais prováveis que outros.
            let limit = 256 - (256 % charset.count)
            if Int(byte) < limit { result.append(charset[Int(byte) % charset.count]) }
        }
        return result
    }

    /// Hash SHA-256 em hexadecimal, o mesmo formato que o backend calcula.
    static func sha256(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
