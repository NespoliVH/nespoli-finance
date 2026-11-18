import Foundation
import Observation

/// Tela de alertas (RF24): categoria, valor atual, média e percentual, lido ou não.
@MainActor
@Observable
final class AlertsViewModel {
    private(set) var alerts: [SpendingAlert] = []
    private(set) var errorMessage: String?
    private(set) var loaded = false
    private let repository: AlertsRepository

    init(repository: AlertsRepository) {
        self.repository = repository
    }

    var unreadCount: Int { alerts.filter { !$0.read }.count }

    func load() async {
        do {
            alerts = try await repository.alerts()
            errorMessage = nil
        } catch let error as APIError {
            errorMessage = error.message
        } catch {
            errorMessage = APIError.invalidResponse.message
        }
        loaded = true
    }

    /// Abrir um alerta marca como lido. A tela muda na hora; se o backend
    /// falhar, volta ao que era.
    func open(_ alert: SpendingAlert) async {
        guard !alert.read, let i = alerts.firstIndex(where: { $0.id == alert.id }) else { return }
        alerts[i].read = true
        do {
            try await repository.markRead(alertID: alert.id)
        } catch {
            alerts[i].read = false
        }
    }

    func markAllRead() async {
        let before = alerts
        for i in alerts.indices { alerts[i].read = true }
        do {
            try await repository.markAllRead()
        } catch {
            alerts = before
        }
    }

    /// "Comida: R$ 980,00, 42% acima da sua média (R$ 690,00)".
    nonisolated static func sentence(_ a: SpendingAlert) -> String {
        "\(Money.format(a.currentCents)) este mês, \(Int(a.increasePct.rounded()))% acima da sua média de \(Money.format(a.averageCents))."
    }
}
