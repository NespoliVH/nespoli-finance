import Foundation

// Formatos das respostas do backend (rotas dos módulos 6 a 9). Os nomes dos
// campos são os mesmos do JSON, para o Codable converter sem mapeamento.

enum CategoryID: String, Codable, CaseIterable, Identifiable {
    case contasFixas = "contas_fixas"
    case comida
    case imprevistos
    case outros

    var id: String { rawValue }

    var name: String {
        switch self {
        case .contasFixas: return "Contas fixas"
        case .comida: return "Comida"
        case .imprevistos: return "Imprevistos"
        case .outros: return "Outros"
        }
    }

    /// Ícone do SF Symbols, o mesmo que o backend grava na tabela de categorias.
    var icon: String {
        switch self {
        case .contasFixas: return "house.fill"
        case .comida: return "fork.knife"
        case .imprevistos: return "exclamationmark.triangle.fill"
        case .outros: return "square.grid.2x2.fill"
        }
    }
}

struct CategoryTotal: Codable, Identifiable, Equatable {
    let id: CategoryID
    let name: String
    let icon: String
    let totalCents: Cents
    let count: Int
    let percentBasisPoints: Int
}

struct ConnectionsState: Codable, Equatable {
    let count: Int
    let importing: Bool
    let oldestSyncAt: Date?
}

struct MonthSummary: Codable, Equatable {
    let month: String // "2026-11"
    let totalCents: Cents
    let categories: [CategoryTotal]
    let unreadAlerts: Int
    let connections: ConnectionsState
}

struct AccountRef: Codable, Equatable {
    let id: String
    let name: String
    let type: String
    let numberLast4: String?
}

struct Transaction: Codable, Identifiable, Equatable {
    let id: String
    let date: String // "2026-11-05": só a data, sem fuso
    let description: String
    let amountCents: Cents
    let direction: Direction
    let status: String
    let isSpending: Bool
    let categoryId: CategoryID?
    let categorySource: String?
    let account: AccountRef

    enum Direction: String, Codable { case debit, credit }

    var isManual: Bool { categorySource == "manual" }
}

struct TransactionPage: Codable, Equatable {
    let items: [Transaction]
    let nextCursor: String?
}

/// Correção de categoria (RF16 a RF18).
struct CategoryCorrection: Encodable, Equatable {
    let categoryId: CategoryID
    /// Criar a regra do estabelecimento para as próximas compras.
    let applyToFuture: Bool
    /// Com a regra, recategorizar também as compras antigas (padrão: sim).
    let includePast: Bool
}

struct CategoryCorrectionResult: Codable, Equatable {
    let transaction: Transaction
    let ruleCreated: Bool
    let recategorizedCount: Int
}

enum TransactionKind: String, CaseIterable, Identifiable {
    case all, spending, income
    var id: String { rawValue }
    var label: String {
        switch self {
        case .all: return "Todas"
        case .spending: return "Gastos"
        case .income: return "Entradas"
        }
    }
}
