import Foundation

/// Estado de uma conexão bancária, como o backend devolve (RF09).
enum ConnectionStatus: String, Decodable, Equatable {
    case updating
    case active
    case loginError = "login_error"
    case consentExpired = "consent_expired"
    case revoked
    /// Um estado novo que esta versão do app ainda não conhece.
    case unknown

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ConnectionStatus(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .updating: return "Atualizando"
        case .active: return "Em dia"
        case .loginError: return "Precisa entrar de novo"
        case .consentExpired: return "Consentimento vencido"
        case .revoked: return "Desconectado pelo banco"
        case .unknown: return "Estado desconhecido"
        }
    }

    /// Login com erro ou consentimento vencido se resolvem reabrindo o Pluggy
    /// Connect para a mesma conexão, sem perder o histórico.
    var needsReconnect: Bool { self == .loginError || self == .consentExpired }
}

struct BankAccount: Decodable, Identifiable, Equatable {
    let id: String
    let type: String
    let name: String
    /// Só os quatro últimos dígitos: o número completo nunca sai do backend.
    let numberLast4: String?
    let balanceCents: Int

    var typeLabel: String {
        switch type {
        case "checking": return "Conta corrente"
        case "savings": return "Poupança"
        case "credit_card": return "Cartão de crédito"
        default: return "Conta"
        }
    }
}

struct BankConnection: Decodable, Identifiable, Equatable {
    let id: String
    let institutionName: String
    var status: ConnectionStatus
    let consentExpiresAt: Date?
    var lastSyncedAt: Date?
    let accounts: [BankAccount]
}

/// Token de curta duração para abrir o Pluggy Connect (RF08). `updateItem`
/// só vem quando o token é para reconectar uma conexão que já existe.
struct ConnectToken: Decodable, Equatable {
    let accessToken: String
    let updateItem: String?
}
