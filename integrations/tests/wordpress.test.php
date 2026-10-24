<?php
// Real SQL, isolated fixture database; no HTTP requests or customer messages.
$name=$argv[1]??'';if(!preg_match('/^clicksurvey_test_sites_[a-f0-9]{12}$/D',$name))throw new Exception('Isolated database required');
$pdo=new PDO('mysql:host=127.0.0.1;port='.getenv('TEST_DB_PORT').';dbname='.$name,'root',getenv('TEST_DB_PASSWORD'),array(PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION));
class WP_Error {function __construct(public $code,public $message,public $data=null){} function get_error_data(){return $this->data;}}
function is_wp_error($x){return $x instanceof WP_Error;}
function nocache_headers(){}
function add_action(...$args){}function add_filter(...$args){}function register_activation_hook(...$args){}function register_deactivation_hook(...$args){}
function get_option($key,$default=false){return $GLOBALS['options'][$key]??$default;}function update_option($key,$v,...$rest){$GLOBALS['options'][$key]=$v;}function delete_option($key){unset($GLOBALS['options'][$key]);}
function is_email($value){return filter_var($value,FILTER_VALIDATE_EMAIL)!==false;}function wp_json_encode($x){return json_encode($x);}
function wp_remote_post($url,$options){$GLOBALS['requests'][]=array($url,$options);$payload=json_decode($options['body'],true);if(count($GLOBALS['requests'])===1)return new WP_Error('http_request_failed','timeout');return array('code'=>202,'body'=>json_encode(array('success'=>true,'eventId'=>$payload['eventId'],'inviteCreated'=>true,'inviteId'=>99)));}
function wp_remote_retrieve_response_code($r){return $r['code'];}function wp_remote_retrieve_body($r){return $r['body'];}
define('ABSPATH',__DIR__.'/');
class FixtureWpdb {
 public $prefix='test_';public $last_error='';
 function __construct(public $pdo){}
 function prepare($sql,...$args){$i=0;return preg_replace_callback('/%[sd]/',function($m)use(&$i,$args){$v=$args[$i++];return $m[0]==='%d'?(string)(int)$v:$this->pdo->quote((string)$v);},$sql);}
 function execute($sql){$this->last_error='';try{return $this->pdo->query($sql);}catch(Throwable $e){$this->last_error=$e->getMessage();throw $e;}}
 function get_var($sql){return $this->execute($sql)->fetchColumn();}
 function get_row($sql){return $this->execute($sql)->fetchObject()?:null;}
 function get_results($sql){return $this->execute($sql)->fetchAll(PDO::FETCH_OBJ);}
 function query($sql){return $this->execute($sql)->rowCount();}
 function insert($table,$data){$q=$this->pdo->prepare('INSERT INTO '.$table.' (`'.implode('`,`',array_keys($data)).'`) VALUES ('.implode(',',array_fill(0,count($data),'?')).')');$q->execute(array_values($data));return $q->rowCount();}
 function update($table,$data,$where){$q=$this->pdo->prepare('UPDATE '.$table.' SET '.implode(',',array_map(fn($k)=>'`'.$k.'`=?',array_keys($data))).' WHERE '.implode(' AND ',array_map(fn($k)=>'`'.$k.'`=?',array_keys($where))));$q->execute(array_merge(array_values($data),array_values($where)));return $q->rowCount();}
}
$wpdb=new FixtureWpdb($pdo);$requests=array();
$pdo->exec("CREATE TABLE test_pp_bookings(id INT PRIMARY KEY,customer_email VARCHAR(254),customer_name VARCHAR(255),payment_status VARCHAR(20));
 CREATE TABLE test_pp_booking_progress(booking_id INT PRIMARY KEY,quest_status VARCHAR(20),completed_at DATETIME);
 CREATE TABLE test_pp_clicksurvey_outbox(id INT AUTO_INCREMENT PRIMARY KEY,event_key VARCHAR(100) UNIQUE,booking_id BIGINT,email VARCHAR(254),payload LONGTEXT,status VARCHAR(32) DEFAULT 'pending',attempts INT DEFAULT 0,next_attempt DATETIME,created_at DATETIME,accepted_at DATETIME,invite_id BIGINT,last_error VARCHAR(80));
 INSERT INTO test_pp_bookings VALUES(1,'guest@example.test','Guest','paid'),(2,'guest@example.test','Guest','paid'),(3,'old@example.test','Old','paid'),(4,'unpaid@example.test','Unpaid','pending'),(5,'unfinished@example.test','Unfinished','paid'),(6,'invalid','Invalid','paid');
 INSERT INTO test_pp_booking_progress VALUES(1,'completed',UTC_TIMESTAMP()),(2,'completed',UTC_TIMESTAMP()),(3,'completed',DATE_SUB(UTC_TIMESTAMP(),INTERVAL 2 DAY)),(4,'completed',UTC_TIMESTAMP()),(5,'in_progress',NULL),(6,'completed',UTC_TIMESTAMP())");
$options=array('pp_cs_schema'=>'1','pp_cs_config'=>array('enabled'=>true,'url'=>'https://clickecommerce.com.au/clicksurvey','key'=>'cs_'.str_repeat('a',24).'_'.str_repeat('b',40),'activated_at'=>gmdate('Y-m-d H:i:s',time()-3600)));
require __DIR__.'/../wordpress/puzzlepath-clicksurvey.php';
function check($value,$message){if(!$value)throw new Exception($message);}
pp_cs_tick();
check(!isset($options['pp_cs_last_error']),'WordPress worker SQL failed');
$counts=$pdo->query('SELECT status,COUNT(*) AS n FROM test_pp_clicksurvey_outbox GROUP BY status')->fetchAll(PDO::FETCH_KEY_PAIR);
check(($counts['pending']??0)==1 && ($counts['throttled']??0)==1 && ($counts['invalid']??0)==1,'Completion/paid/future/cooldown eligibility failed');
check(count($requests)===0,'Collection mode made an outbound request');
function absint($n){return abs((int)$n);}
class RequestFixture {function __construct(public $body=array(),public $authorization=''){}function get_json_params(){return $this->body;}function get_header($n){return $this->authorization;}}
check(!pp_cs_permission(new RequestFixture()),'Anonymous queue access allowed');
check(pp_cs_permission(new RequestFixture(array(),'Bearer '.$options['pp_cs_config']['key'])),'Authenticated collection rejected');
$first=pp_cs_collect()['events'];check(count($first)===1,'Wrong collection batch');
pp_cs_acknowledge(new RequestFixture(array('eventId'=>$first[0]['eventId'],'status'=>'retry')));
check(count(pp_cs_collect()['events'])===0,'Retry delay ignored');
$pdo->exec("UPDATE test_pp_clicksurvey_outbox SET next_attempt=UTC_TIMESTAMP() WHERE status='pending'");
$retry=pp_cs_collect()['events'];check($first===$retry,'Retry changed stable payload');
pp_cs_acknowledge(new RequestFixture(array('eventId'=>$first[0]['eventId'],'status'=>'accepted','inviteId'=>99)));
check($pdo->query("SELECT COUNT(*) FROM test_pp_clicksurvey_outbox WHERE status='accepted' AND attempts=2 AND invite_id=99")->fetchColumn()==1,'Queue acknowledgement missing');
pp_cs_tick();check(count(pp_cs_collect()['events'])===0,'Accepted or throttled completion replayed');
$options['pp_cs_config']['enabled']=false;pp_cs_tick();check(!pp_cs_permission(new RequestFixture(array(),'Bearer '.$options['pp_cs_config']['key'])),'Disabled integration exposed queue');
echo "WordPress queue checks passed: new paid completions only, no historical backfill, cooldown, stable retry, acknowledgement, duplicate prevention and disable guard.\n";
