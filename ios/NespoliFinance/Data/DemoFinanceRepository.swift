import Foundation

/// Modo demonstração: dados de mentira, guardados só na memória.
///
/// Serve para duas coisas. Enquanto o login com a Apple não existe (depende
/// da conta paga), o app abre e funciona inteiro com estes dados. E na defesa
/// do TCC, as telas podem ser mostradas sem expor dados bancários reais.
/// As regras imitam as do backend: o que conta como gasto, a correção manual
/// e a regra do estabelecimento com as compras antigas.
actor DemoFinanceRepository: FinanceRepository {
    struct Item {
        var tx: Transaction
        let merchant: String
    }

    private var items: [Item]
    private var rules: [String: CategoryID] = [:]
    var demoAlerts: [SpendingAlert]
    var demoTaxProfile: TaxProfile?
    var demoConnections: [BankConnection]
    let month: String

    init(month: String = DemoFinanceRepository.currentMonth()) {
        self.month = month
        self.items = DemoFinanceRepository.sample(month: month)
        self.demoAlerts = DemoFinanceRepository.sampleAlerts(month: month)
        self.demoTaxProfile = TaxProfile(grossMonthlySalaryCents: 1_000_000, withheldMonthlyCents: nil, dependentsCount: 0)
        self.demoConnections = DemoFinanceRepository.sampleConnections()
    }

    func resetDemo() {
        items = Self.sample(month: month)
        rules = [:]
        demoAlerts = Self.sampleAlerts(month: month)
        demoTaxProfile = nil
        demoConnections = []
    }

    static func sampleAlerts(month: String) -> [SpendingAlert] {
        [
            SpendingAlert(id: "a1", month: month, category: CategoryRef(id: .comida, name: "Comida", icon: CategoryID.comida.icon),
                          currentCents: 98_000, averageCents: 69_000, increasePct: 42.03, read: false, createdAt: Date().addingTimeInterval(-7_200)),
            SpendingAlert(id: "a0", month: SummaryViewModel.shift(month, by: -1),
                          category: CategoryRef(id: .imprevistos, name: "Imprevistos", icon: CategoryID.imprevistos.icon),
                          currentCents: 60_000, averageCents: 40_000, increasePct: 50, read: true, createdAt: Date().addingTimeInterval(-2_600_000)),
        ]
    }

    static func currentMonth(_ now: Date = Date()) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "America/Sao_Paulo")!
        let c = cal.dateComponents([.year, .month], from: now)
        return String(format: "%04d-%02d", c.year!, c.month!)
    }

    func summary(month: String?) async throws -> MonthSummary {
        let m = month ?? self.month
        let spending = items.map(\.tx).filter { $0.isSpending && $0.date.hasPrefix(m) }
        let total = spending.reduce(0) { $0 + $1.amountCents }
        let categories = CategoryID.allCases.map { cat -> CategoryTotal in
            let txs = spending.filter { $0.categoryId == cat }
            let cents = txs.reduce(0) { $0 + $1.amountCents }
            return CategoryTotal(
                id: cat, name: cat.name, icon: cat.icon, totalCents: cents, count: txs.count,
                percentBasisPoints: total == 0 ? 0 : Int((Double(cents) * 10_000 / Double(total)).rounded())
            )
        }
        return MonthSummary(
            month: m, totalCents: total, categories: categories, unreadAlerts: 1,
            connections: ConnectionsState(count: 1, importing: false, oldestSyncAt: Date().addingTimeInterval(-3600))
        )
    }

    func transactions(month: String?, kind: TransactionKind, category: CategoryID?, cursor: String?) async throws -> TransactionPage {
        let m = month ?? self.month
        let list = items.map(\.tx)
            .filter { $0.date.hasPrefix(m) }
            .filter { tx in
                switch kind {
                case .all: return category == nil || (tx.isSpending && tx.categoryId == category)
                case .spending: return tx.isSpending && (category == nil || tx.categoryId == category)
                case .income: return tx.direction == .credit
                }
            }
            .sorted { ($0.date, $0.id) > ($1.date, $1.id) }
        return TransactionPage(items: list, nextCursor: nil)
    }

    func correctCategory(transactionID: String, _ c: CategoryCorrection) async throws -> CategoryCorrectionResult {
        guard let index = items.firstIndex(where: { $0.tx.id == transactionID }) else { throw APIError.notFound }
        guard items[index].tx.isSpending else { throw APIError.server(status: 422, code: "not_spending") }
        items[index].tx = items[index].tx.with(category: c.categoryId, source: "manual")
        let merchant = items[index].merchant
        var count = 0
        if c.applyToFuture {
            rules[merchant] = c.categoryId
            if c.includePast {
                for i in items.indices where i != index && items[i].merchant == merchant && items[i].tx.isSpending && !items[i].tx.isManual {
                    items[i].tx = items[i].tx.with(category: c.categoryId, source: "user_rule")
                    count += 1
                }
            }
        }
        return CategoryCorrectionResult(transaction: items[index].tx, ruleCreated: c.applyToFuture, recategorizedCount: count)
    }

    /// Marcações do IR no modo demonstração, com as mesmas regras do backend.
    func markTax(transactionID: String, _ mark: TaxMark) async throws {
        guard let index = items.firstIndex(where: { $0.tx.id == transactionID }) else { throw APIError.notFound }
        var tx = items[index].tx
        if mark.taxableIncome != nil || mark.incomeSource != nil {
            guard tx.direction == .credit else { throw APIError.server(status: 422, code: "not_income") }
        }
        if mark.deductibleType != nil {
            guard tx.isSpending else { throw APIError.server(status: 422, code: "not_spending") }
        }
        if let income = mark.taxableIncome { tx.taxableIncome = income }
        if case .some(let source) = mark.incomeSource { tx.incomeSource = source }
        if case .some(let type) = mark.deductibleType { tx.deductibleType = type }
        items[index].tx = tx
    }

    // MARK: - Dados de exemplo

    static func sample(month: String) -> [Item] {
        let account = AccountRef(id: "demo-conta", name: "Conta corrente", type: "checking", numberLast4: "1234")
        let card = AccountRef(id: "demo-cartao", name: "Cartão", type: "credit_card", numberLast4: "9876")
        func tx(_ id: String, _ day: Int, _ desc: String, _ cents: Cents, _ cat: CategoryID?, merchant: String,
                credit: Bool = false, acc: AccountRef = card, spending: Bool = true, income: String? = nil) -> Item {
            Item(tx: Transaction(
                id: id, date: String(format: "%@-%02d", month, day), description: desc, amountCents: cents,
                direction: credit ? .credit : .debit, status: "posted", isSpending: spending && !credit,
                categoryId: spending && !credit ? cat : nil, categorySource: spending && !credit ? "pluggy" : nil, account: acc,
                taxableIncome: credit ? (income ?? "no") : nil
            ), merchant: merchant)
        }
        return [
            tx("d01", 5, "SALARIO EMPRESA X", 750_000, nil, merchant: "salario", credit: true, acc: account, income: "confirmed"),
            tx("d02", 5, "ALUGUEL", 180_000, .contasFixas, merchant: "aluguel", acc: account),
            tx("d03", 6, "ENEL ENERGIA", 21_450, .contasFixas, merchant: "enel energia", acc: account),
            tx("d04", 7, "IFOOD *RESTAURANTE", 6_890, .comida, merchant: "ifood"),
            tx("d05", 8, "SUPERMERCADO BOM PRECO", 34_210, .comida, merchant: "supermercado bom preco"),
            tx("d06", 9, "NETFLIX.COM", 5_590, .contasFixas, merchant: "netflix com"),
            tx("d07", 10, "IFOOD *LANCHONETE", 4_250, .outros, merchant: "ifood"),
            tx("d08", 11, "DROGASIL", 8_990, .outros, merchant: "drogasil"),
            tx("d09", 12, "PAG FATURA CARTAO", 120_000, nil, merchant: "fatura", acc: account, spending: false),
            tx("d10", 13, "OFICINA MECANICA", 45_000, .imprevistos, merchant: "oficina mecanica"),
            tx("d11", 14, "IFOOD *PIZZARIA", 7_900, .outros, merchant: "ifood"),
            tx("d12", 15, "PIX RECEBIDO MARIA", 5_000, nil, merchant: "pix maria", credit: true, acc: account, income: "suggested"),
        ]
    }
}

extension Transaction {
    func with(category: CategoryID, source: String) -> Transaction {
        Transaction(id: id, date: date, description: description, amountCents: amountCents, direction: direction,
                    status: status, isSpending: isSpending, categoryId: category, categorySource: source, account: account,
                    taxableIncome: taxableIncome, deductibleType: deductibleType, incomeSource: incomeSource)
    }
}
