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
    /// Marcações do IR (RF25, RF26). Opcionais: o modo demonstração e respostas antigas não têm.
    var taxableIncome: String? = nil // "no", "suggested" ou "confirmed"
    var deductibleType: String? = nil // "health", "education", "pension" ou "business" (livro-caixa)
    var incomeSource: String? = nil // "individual" ou "company"

    enum Direction: String, Codable { case debit, credit }

    var isManual: Bool { categorySource == "manual" }
    var isConfirmedIncome: Bool { taxableIncome == "confirmed" }
}

/// O que mudar nas marcações do IR de uma transação. Campo ausente fica como
/// está; deductibleType ou incomeSource com valor nulo apaga a marcação.
struct TaxMark: Encodable, Equatable {
    var taxableIncome: String?
    var incomeSource: String??
    var deductibleType: String??

    private enum CodingKeys: String, CodingKey { case taxableIncome, incomeSource, deductibleType }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(taxableIncome, forKey: .taxableIncome)
        if case .some(let value) = incomeSource { try c.encode(value, forKey: .incomeSource) }
        if case .some(let value) = deductibleType { try c.encode(value, forKey: .deductibleType) }
    }
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

// MARK: - Alertas (módulo 7)

struct CategoryRef: Codable, Equatable {
    let id: CategoryID
    let name: String
    let icon: String
}

struct SpendingAlert: Codable, Identifiable, Equatable {
    let id: String
    let month: String
    let category: CategoryRef
    let currentCents: Cents
    let averageCents: Cents
    let increasePct: Double
    var read: Bool
    let createdAt: Date
}

struct AlertList: Codable, Equatable {
    let items: [SpendingAlert]
}

// MARK: - IR (módulo 8)

/// Como a pessoa recebe (seção 4.8.1): define se há carnê-leão.
enum IncomeType: String, Codable, CaseIterable, Identifiable {
    case salaried
    case selfEmployed = "self_employed"
    case both

    var id: String { rawValue }
    var label: String {
        switch self {
        case .salaried: return "Assalariado"
        case .selfEmployed: return "Autônomo"
        case .both: return "Os dois"
        }
    }
    var hasSalary: Bool { self != .selfEmployed }
    var hasSelfEmployment: Bool { self != .salaried }
}

/// Como o autônomo contribui ao INSS (contribuinte individual).
enum InssPlan: String, Codable, CaseIterable, Identifiable {
    case standard, simplified, none

    var id: String { rawValue }
    var label: String {
        switch self {
        case .standard: return "20% sobre o que recebo"
        case .simplified: return "11% do salário mínimo (plano simplificado)"
        case .none: return "Não contribuo"
        }
    }
}

struct TaxProfile: Codable, Equatable {
    var grossMonthlySalaryCents: Cents
    var withheldMonthlyCents: Cents?
    var dependentsCount: Int
    var incomeType: IncomeType = .salaried
    var inssPlan: InssPlan = .standard

    init(grossMonthlySalaryCents: Cents, withheldMonthlyCents: Cents?, dependentsCount: Int,
         incomeType: IncomeType = .salaried, inssPlan: InssPlan = .standard) {
        self.grossMonthlySalaryCents = grossMonthlySalaryCents
        self.withheldMonthlyCents = withheldMonthlyCents
        self.dependentsCount = dependentsCount
        self.incomeType = incomeType
        self.inssPlan = inssPlan
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        grossMonthlySalaryCents = try c.decode(Cents.self, forKey: .grossMonthlySalaryCents)
        withheldMonthlyCents = try c.decodeIfPresent(Cents.self, forKey: .withheldMonthlyCents)
        dependentsCount = try c.decode(Int.self, forKey: .dependentsCount)
        // Perfis gravados antes do autônomo não têm esses campos.
        incomeType = try c.decodeIfPresent(IncomeType.self, forKey: .incomeType) ?? .salaried
        inssPlan = try c.decodeIfPresent(InssPlan.self, forKey: .inssPlan) ?? .standard
    }
}

struct TaxStep: Codable, Equatable, Identifiable {
    let label: String
    let amountCents: Cents
    var id: String { label }
}

struct TaxEstimate: Codable, Equatable {
    struct Alternative: Codable, Equatable {
        let regime: String
        let taxDueCents: Cents
    }
    let year: Int
    let taxableIncomeCents: Cents
    let regime: String // "complete" ou "simplified"
    let taxDueCents: Cents
    let withheldCents: Cents
    var carneLeaoPaidCents: Cents? = nil
    let differenceCents: Cents
    let steps: [TaxStep]
    let alternative: Alternative

    var regimeName: String { regime == "complete" ? "completa (deduções reais)" : "simplificada (desconto de 20%)" }
}

struct TaxEstimateResponse: Codable, Equatable {
    let year: Int
    let disclaimer: String
    let tableVerifiedOfficial: Bool
    let estimate: TaxEstimate
    let monthlyReserveCents: Cents
    let monthsUntilDeadline: Int
    var incomeType: IncomeType? = nil
    var carneLeao: CarneLeao? = nil
}

/// Carnê-leão do autônomo: o imposto de cada mês sobre o que recebeu de pessoas físicas.
struct CarneLeao: Codable, Equatable {
    let darfCode: String
    let months: [CarneLeaoMonth]
    let totalSoFarCents: Cents
    let projectedAnnualCents: Cents
}

struct CarneLeaoMonth: Codable, Equatable, Identifiable {
    let month: String // "2026-03"
    let fromIndividualsCents: Cents
    let fromCompaniesCents: Cents
    let inssPaidCents: Cents
    let inssWithheldCents: Cents
    let bookDeductionCents: Cents
    let deductionKind: String // "legal" ou "simplified"
    let deductionCents: Cents
    let baseCents: Cents
    let taxCents: Cents
    let payableCents: Cents
    let dueDate: String? // "2026-04-30"

    var id: String { month }
    var hasActivity: Bool { fromIndividualsCents > 0 || fromCompaniesCents > 0 || payableCents > 0 }
}

// MARK: - Conta e privacidade (módulo 9)

struct Me: Codable, Equatable {
    let id: String
    let name: String?
    let email: String?
    let connectionsCount: Int
    let devicesCount: Int
    let hasTaxProfile: Bool
}

struct ConsentRecord: Codable, Identifiable, Equatable {
    let id: String
    let type: String // "bank_data_sharing" ou "privacy_policy"
    let action: String // "granted" ou "revoked"
    let purpose: String
    let termsVersion: String
    let occurredAt: Date
    let institutionName: String?

    var title: String {
        let what = type == "privacy_policy" ? "Política de privacidade" : "Dados do banco\(institutionName.map { " (\($0))" } ?? "")"
        return what
    }
    var actionLabel: String { action == "granted" ? "Concedido" : "Revogado" }
}

struct ConsentList: Codable, Equatable {
    let items: [ConsentRecord]
}
