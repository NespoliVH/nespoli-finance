import SwiftUI

/// Cor de cada categoria, a mesma em todas as telas. Cores do sistema, que se
/// ajustam sozinhas ao modo escuro (RNF17).
extension CategoryID {
    var color: Color {
        switch self {
        case .contasFixas: return .blue
        case .comida: return .orange
        case .imprevistos: return .red
        case .outros: return .gray
        }
    }
}
