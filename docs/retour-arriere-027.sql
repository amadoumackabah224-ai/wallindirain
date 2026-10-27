-- RETOUR ARRIÈRE de la migration 027 (notifications et annonces). JAMAIS AUTOMATIQUE.
-- Aucune donnée financière : seules les notifications et l'historique des annonces sont perdus. Retirer aussi le code déployé correspondant.
BEGIN;
DROP TRIGGER IF EXISTS orders_notify ON orders;
DROP TRIGGER IF EXISTS withdrawals_notify ON withdrawals;
DROP TRIGGER IF EXISTS wallet_bonus_notify ON wallet_entries;
DROP TRIGGER IF EXISTS identity_notify ON identity_documents;
DROP TRIGGER IF EXISTS products_notify ON products;
DROP TRIGGER IF EXISTS tours_notify ON tours;
DROP TRIGGER IF EXISTS support_notify ON support_messages;
DROP FUNCTION _notify_order_status();
DROP FUNCTION _notify_withdrawal();
DROP FUNCTION _notify_bonus();
DROP FUNCTION _notify_identity();
DROP FUNCTION _notify_product();
DROP FUNCTION _notify_tour();
DROP FUNCTION _notify_support();
DROP FUNCTION fn_my_notifications(uuid, int);
DROP FUNCTION fn_notifications_unread(uuid);
DROP FUNCTION fn_notifications_read(uuid, bigint[]);
DROP FUNCTION fn_admin_announce(uuid, text, text, text);
DROP FUNCTION fn_admin_announcements(uuid);
DROP FUNCTION _notify(uuid, text, text, text, text);
DROP FUNCTION _gnf_text(bigint);
DROP TABLE announcements;
DROP TABLE notifications;
DELETE FROM schema_migrations WHERE name = '027_notifications.sql';
COMMIT;
