<?php
// Standalone settings/payload checks; no WordPress, database or network required.
define('ABSPATH', __DIR__ . '/');
function add_action(...$args) {} function add_filter(...$args) {}
function register_activation_hook(...$args) {} function register_deactivation_hook(...$args) {}
function get_option($key, $default = false) { return $GLOBALS['config']; }
function wp_die($message) { throw new RuntimeException($message); }
require __DIR__ . '/../wordpress/puzzlepath-clicksurvey.php';
function check($value) { if (!$value) throw new RuntimeException('Assertion failed'); }
$GLOBALS['config'] = array('email_sender_name' => 'Puzzle Path', 'email_subject' => 'How was your adventure?');
$row = (object) array('id' => 1, 'customer_email' => 'GUEST@example.com', 'customer_name' => 'Guest');
$first = pp_cs_payload($row, 'hunt_completed:1');
check($first['metadata']->invitationEmail->senderName === 'Puzzle Path');
check($first['metadata']->invitationEmail->subject === 'How was your adventure?');
check($first['recipient']['email'] === 'guest@example.com');
check(pp_cs_email_metadata(array('purpose' => 'Connection verification'))->invitationEmail->subject === 'How was your adventure?');
$GLOBALS['config'] = array();
check(!isset(pp_cs_payload($row, 'hunt_completed:2')['metadata']->invitationEmail));
check($first['metadata']->invitationEmail->senderName === 'Puzzle Path');
check(pp_cs_email_setting('  Puzzle Path  ') === 'Puzzle Path');
foreach (array("bad\nheader", "bad\rheader", str_repeat('a', 256), array('bad')) as $value) {
    try { pp_cs_email_setting($value); throw new Exception('Invalid setting accepted'); }
    catch (RuntimeException $expected) {}
}
echo "Plugin email settings and payload checks passed.\n";
