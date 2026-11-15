//! Хранилище аккаунтов: `accounts.json` в корне данных лаунчера.
//!
//! Один файл на все аккаунты + отметка, какой выбран. Офлайн-аккаунтов может
//! быть сколько угодно (ник), лицензионных — тоже; переключение мгновенное,
//! потому что токен уже лежит рядом (обновляется по `refresh_token`).

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::auth::Account;
use crate::error::Result;
use crate::paths::Paths;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AccountStore {
    /// Все аккаунты по порядку.
    pub accounts: Vec<Account>,
    /// UUID выбранного аккаунта.
    pub active: Option<String>,
}

impl AccountStore {
    pub fn load(paths: &Paths) -> Self {
        Self::load_from(&paths.accounts_file()).unwrap_or_default()
    }

    pub fn load_from(file: &Path) -> Result<Self> {
        if !file.exists() {
            return Ok(Self::default());
        }
        let text = std::fs::read_to_string(file)?;
        // Битый файл не должен мешать запуску: просто начинаем с чистого списка.
        Ok(serde_json::from_str(&text).unwrap_or_default())
    }

    pub fn save(&self, paths: &Paths) -> Result<()> {
        self.save_to(&paths.accounts_file())
    }

    pub fn save_to(&self, file: &Path) -> Result<()> {
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let text = serde_json::to_string_pretty(self)?;
        std::fs::write(file, text)?;
        Ok(())
    }

    /// Добавить аккаунт или обновить существующий с тем же UUID.
    pub fn upsert(&mut self, account: Account) -> Account {
        if let Some(existing) = self
            .accounts
            .iter_mut()
            .find(|item| item.uuid.eq_ignore_ascii_case(&account.uuid))
        {
            *existing = account.clone();
        } else {
            self.accounts.push(account.clone());
        }
        account
    }

    pub fn remove(&mut self, uuid: &str) -> bool {
        let before = self.accounts.len();
        self.accounts
            .retain(|item| !item.uuid.eq_ignore_ascii_case(uuid));
        if self.active.as_deref() == Some(uuid) {
            self.active = self.accounts.first().map(|item| item.uuid.clone());
        }
        self.accounts.len() != before
    }

    pub fn find(&self, uuid: &str) -> Option<&Account> {
        self.accounts
            .iter()
            .find(|item| item.uuid.eq_ignore_ascii_case(uuid))
    }

    pub fn find_mut(&mut self, uuid: &str) -> Option<&mut Account> {
        self.accounts
            .iter_mut()
            .find(|item| item.uuid.eq_ignore_ascii_case(uuid))
    }

    /// Выбранный аккаунт: явный выбор → первый в списке → None.
    pub fn current(&self) -> Option<&Account> {
        if let Some(active) = &self.active {
            if let Some(account) = self.find(active) {
                return Some(account);
            }
        }
        self.accounts.first()
    }

    pub fn set_active(&mut self, uuid: &str) -> bool {
        if self.find(uuid).is_some() {
            self.active = Some(uuid.to_string());
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_and_switch() {
        let mut store = AccountStore::default();
        let steve = Account::offline("Steve").unwrap();
        store.upsert(steve.clone());
        assert_eq!(store.accounts.len(), 1);
        // повторное добавление того же ника не плодит копии
        store.upsert(Account::offline("Steve").unwrap());
        assert_eq!(store.accounts.len(), 1);
        assert!(store.set_active(&steve.uuid));
        assert_eq!(store.current().unwrap().username, "Steve");
    }

    #[test]
    fn remove_switches_active() {
        let mut store = AccountStore::default();
        let alex = Account::offline("Alex").unwrap();
        let steve = Account::offline("Steve").unwrap();
        store.upsert(alex.clone());
        store.upsert(steve.clone());
        store.set_active(&steve.uuid);
        assert!(store.remove(&steve.uuid));
        assert_eq!(store.current().unwrap().username, "Alex");
        assert!(!store.remove("нет-такого"));
    }
}
