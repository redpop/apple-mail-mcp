import Foundation
import Testing
import MailHelperCore

@Test func storeExists() {
    let tmp = URL(fileURLWithPath: "/nonexistent")
    _ = MailStore(config: MailStoreConfig(mailRoot: tmp, accountsDB: tmp))
}
