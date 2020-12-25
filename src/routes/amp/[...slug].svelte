<script context="module">
	export async function preload({ params }) {
		const res = await this.fetch(`blog/${params.slug}.json`);
		const data = await res.json();

		if (res.status === 200) {
			return { post: data };
		} else {
			this.error(res.status, data.message);
		}
	}
</script>

<script>
  import successkid from 'images/successkid.jpg';
	export let post;
</script>

<a href="amp/">Back to articles</a>
<h1>{post.title}</h1>
<amp-img alt="success kid" src={successkid} width="400px" height="266px"/>
<div>{@html post.html}</div>